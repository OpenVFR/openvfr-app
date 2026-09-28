/**
 * withMapLibreHttpGuardIos — iOS half of withMapLibreHttpGuard (Android).
 * Read that file's header first; the bug and the rules are identical, only
 * the hook differs.
 *
 * MapLibre iOS (platform/darwin/core/http_file_source.mm, verified at the
 * 6.31.0 tag @maplibre/maplibre-react-native pins) issues every request as
 * `[session dataTaskWithRequest:completionHandler:]` -- the completion-
 * handler form, which buffers the WHOLE body before calling back -- and
 * then accepts any 200/206 with no size check and no "was my Range
 * honoured" check. Its `didReceiveResponse:` delegate hook fires after that
 * buffering, with the full NSData already in memory, so it cannot prevent
 * the allocation. A 668 MB body means iOS jetsams the process.
 *
 * The hook that CAN act early is an `NSURLProtocol` registered on
 * `MLNNetworkConfiguration.sharedManager.sessionConfiguration`: MapLibre
 * builds its NSURLSession from that configuration, so the protocol sees
 * every MapLibre request, and its `didReceive response` callback runs on
 * the response HEADERS, before any body bytes are delivered. That is the
 * same moment the Android OkHttp interceptor acts. Same three rules:
 *   1. Range request answered with a 2xx that is not 206  -> fail
 *   2. Content-Length > MAX_BODY_BYTES                     -> fail
 *   3. no Content-Length: body grows past MAX_BODY_BYTES    -> fail
 * A failure is reported to MapLibre as an ordinary URL error, which it
 * already treats as a transient network failure and retries.
 *
 * Implementation notes:
 *   - One shared inner URLSession for all requests (a session per request
 *     would be far too expensive at tile-fetch rates); a delegate maps task
 *     identifier -> protocol instance. The inner session's config has an
 *     empty protocolClasses so it can never re-enter this protocol.
 *   - Injected as an extra type at the bottom of AppDelegate.swift rather
 *     than a separate file: Swift allows multiple top-level types per file,
 *     and this avoids editing the .pbxproj to register a new source file.
 *   - No `import MapLibre`. MapLibre is vendored into the RN pod through SPM
 *     and whether its module is importable from the app target is exactly
 *     the kind of thing that only fails on the CI Mac. MLNNetworkConfiguration
 *     is an ObjC class with plain ObjC properties, so it is reached through
 *     the ObjC runtime (NSClassFromString + KVC) instead: a lookup miss logs
 *     and leaves MapLibre unguarded rather than breaking the build.
 *   - This machine cannot compile Swift; the code is checked by the iOS CI
 *     build. Keep it plain Foundation for that reason.
 */
const { withAppDelegate } = require('@expo/config-plugins')

const MARK_INSTALL = '// withMapLibreHttpGuardIos: install'
const MARK_TYPES = '// withMapLibreHttpGuardIos: guard types (generated -- do not edit, see plugins/withMapLibreHttpGuardIos.js)'

const SWIFT_TYPES = `
${MARK_TYPES}

/// Guarded URL loading for MapLibre Native. See plugins/withMapLibreHttpGuardIos.js.
enum MapLibreHttpGuard {
  /// Largest single response MapLibre may read into memory. PMTiles range
  /// slices are tens of KB; styles/sprites/glyphs/vector tiles are well under
  /// a few MB. Anything bigger is a whole-archive response, not a tile.
  static let maxBodyBytes: Int64 = 32 * 1024 * 1024

  static func install() {
    let cfg = URLSessionConfiguration.default
    cfg.protocolClasses = [MapLibreHttpGuardProtocol.self]
    // MLNNetworkConfiguration.sharedManager.sessionConfiguration = cfg, via
    // the ObjC runtime (see file header for why there is no import). Must run
    // before any MLNMapView / MLNOfflineStorage exists -- MapLibre copies the
    // configuration when it builds its session.
    guard let cls = NSClassFromString("MLNNetworkConfiguration") as? NSObject.Type,
          let shared = cls.value(forKey: "sharedManager") as? NSObject else {
      NSLog("MapLibreHttpGuard: MLNNetworkConfiguration not found -- MapLibre HTTP is UNGUARDED")
      return
    }
    shared.setValue(cfg, forKey: "sessionConfiguration")
  }
}

final class MapLibreHttpGuardProtocol: URLProtocol {
  private static let delegate = InnerDelegate()
  private static let inner: URLSession = {
    let c = URLSessionConfiguration.default
    c.protocolClasses = []          // never re-enter this protocol
    return URLSession(configuration: c, delegate: delegate, delegateQueue: nil)
  }()

  private var innerTask: URLSessionDataTask?
  fileprivate var failed = false
  fileprivate var received: Int64 = 0

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let t = Self.inner.dataTask(with: request)
    innerTask = t
    Self.delegate.register(t, self)
    t.resume()
  }

  override func stopLoading() {
    if let t = innerTask { Self.delegate.unregister(t); t.cancel() }
    innerTask = nil
  }

  fileprivate func fail(_ message: String) {
    guard !failed else { return }
    failed = true
    let err = NSError(
      domain: NSURLErrorDomain, code: NSURLErrorCannotParseResponse,
      userInfo: [NSLocalizedDescriptionKey: "MapLibreHttpGuard: " + message + ": " + (request.url?.absoluteString ?? "?")]
    )
    innerTask?.cancel()
    client?.urlProtocol(self, didFailWithError: err)
  }

  /// Maps inner-session tasks back to the protocol instance that owns them.
  private final class InnerDelegate: NSObject, URLSessionDataDelegate {
    private var owners: [Int: MapLibreHttpGuardProtocol] = [:]
    private let lock = NSLock()

    func register(_ t: URLSessionTask, _ p: MapLibreHttpGuardProtocol) { lock.lock(); owners[t.taskIdentifier] = p; lock.unlock() }
    func unregister(_ t: URLSessionTask) { lock.lock(); owners.removeValue(forKey: t.taskIdentifier); lock.unlock() }
    private func owner(_ t: URLSessionTask) -> MapLibreHttpGuardProtocol? { lock.lock(); defer { lock.unlock() }; return owners[t.taskIdentifier] }

    // Headers arrived, body not yet: the only place the guard can act early.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
      guard let p = owner(dataTask) else { completionHandler(.cancel); return }
      if let http = response as? HTTPURLResponse {
        let range = p.request.value(forHTTPHeaderField: "Range")
        let code = http.statusCode
        // 1. Range request answered with the whole resource instead of a slice.
        if range != nil, (200...299).contains(code), code != 206 {
          p.fail("Range request (\\(range!)) answered with HTTP \\(code) (Content-Length \\(http.expectedContentLength)) instead of 206 -- refusing to buffer the whole resource")
          completionHandler(.cancel); return
        }
        // 2. Declared size over the cap.
        if http.expectedContentLength > MapLibreHttpGuard.maxBodyBytes {
          p.fail("Content-Length \\(http.expectedContentLength) exceeds \\(MapLibreHttpGuard.maxBodyBytes) bytes")
          completionHandler(.cancel); return
        }
      }
      p.client?.urlProtocol(p, didReceive: response, cacheStoragePolicy: .allowed)
      completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      guard let p = owner(dataTask), !p.failed else { return }
      p.received += Int64(data.count)
      // 3. Unknown size (no/-1 Content-Length): cap while streaming.
      if p.received > MapLibreHttpGuard.maxBodyBytes {
        p.fail("streamed body exceeded \\(MapLibreHttpGuard.maxBodyBytes) bytes")
        return
      }
      p.client?.urlProtocol(p, didLoad: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard let p = owner(task) else { return }
      unregister(task)
      if p.failed { return }          // already reported by fail()
      if let e = error { p.client?.urlProtocol(p, didFailWithError: e) }
      else { p.client?.urlProtocolDidFinishLoading(p) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      // Let the inner session follow redirects transparently; the guard then
      // inspects the final response's headers as usual.
      completionHandler(request)
    }
  }
}
`

module.exports = function withMapLibreHttpGuardIos(config) {
  return withAppDelegate(config, (config) => {
    let src = config.modResults.contents
    if (config.modResults.language !== 'swift') {
      throw new Error('withMapLibreHttpGuardIos: expected a Swift AppDelegate (Expo SDK 53+); found ' + config.modResults.language)
    }
    if (!src.includes(MARK_INSTALL)) {
      // First statement of didFinishLaunchingWithOptions, before any React /
      // Expo setup can create a map view.
      src = src.replace(
        /(func application\(\s*_ application: UIApplication,\s*didFinishLaunchingWithOptions launchOptions: [^\n]*\n\s*\) -> Bool \{\s*\n)/,
        `$1    MapLibreHttpGuard.install() ${MARK_INSTALL}\n`,
      )
      if (!src.includes(MARK_INSTALL)) throw new Error('withMapLibreHttpGuardIos: could not find application(_:didFinishLaunchingWithOptions:) in AppDelegate.swift')
    }
    if (!src.includes(MARK_TYPES)) src = src.trimEnd() + '\n' + SWIFT_TYPES
    config.modResults.contents = src
    return config
  })
}
