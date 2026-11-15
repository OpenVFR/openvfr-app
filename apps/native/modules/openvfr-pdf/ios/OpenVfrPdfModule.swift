import ExpoModulesCore
import PDFKit
import UIKit

/// Renders one page of a PDF (or a crop of it) to a PNG file with PDFKit. Used by the chart viewer and the georeferenced chart overlay
/// (src/utils/charts.ts). The JS side checks the document and caps the pixel count; this only draws.
/// NOTE: written without a Mac to compile it on; the Android side is the one that has been built and tried.
internal final class PdfException: GenericException<String> {
  override var reason: String { param }
}

public class OpenVfrPdfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpenVfrPdf")

    // { pageCount, widthPt, heightPt } of page `pageNumber` (1-based; page size in PDF points).
    AsyncFunction("pageInfo") { (fileUri: String, pageNumber: Int) -> [String: Any] in
      let doc = try Self.open(fileUri)
      guard pageNumber >= 1, pageNumber <= doc.pageCount, let page = doc.page(at: pageNumber - 1) else {
        throw PdfException("the document has no page \(pageNumber)")
      }
      let b = page.bounds(for: .mediaBox)
      return ["pageCount": doc.pageCount, "widthPt": Double(b.width), "heightPt": Double(b.height)]
    }

    // Draws page `page` (1-based), the part given by `crop` = [left, top, right, bottom] as page fractions, at width x height px.
    AsyncFunction("renderPage") { (fileUri: String, pageNumber: Int, width: Int, height: Int, crop: [Double], outUri: String) -> [String: Any] in
      guard width >= 1, height >= 1, crop.count == 4 else { throw PdfException("bad size or crop") }
      let doc = try Self.open(fileUri)
      guard pageNumber >= 1, pageNumber <= doc.pageCount, let page = doc.page(at: pageNumber - 1) else {
        throw PdfException("the document has no page \(pageNumber)")
      }
      let box = page.bounds(for: .mediaBox)
      let pw = box.width, ph = box.height
      let l = CGFloat(crop[0]), t = CGFloat(crop[1]), r = CGFloat(crop[2]), b = CGFloat(crop[3])
      let cropW = pw * (r - l), cropH = ph * (b - t)
      guard cropW > 0, cropH > 0 else { throw PdfException("empty crop") }

      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
      let image = renderer.image { ctx in
        UIColor.white.setFill()
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let cg = ctx.cgContext
        // PDF space has its origin bottom-left, y up: flip to that, scale the crop to the bitmap, shift the crop's bottom-left to 0.
        cg.translateBy(x: 0, y: CGFloat(height))
        cg.scaleBy(x: 1, y: -1)
        cg.scaleBy(x: CGFloat(width) / cropW, y: CGFloat(height) / cropH)
        cg.translateBy(x: -l * pw - box.minX, y: -(1 - b) * ph - box.minY)
        page.draw(with: .mediaBox, to: cg)
      }
      guard let data = image.pngData() else { throw PdfException("could not encode the page") }
      guard let out = outUri.hasPrefix("file:") ? URL(string: outUri) : URL(fileURLWithPath: outUri) else { throw PdfException("bad output path") }
      try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: out)
      return ["uri": out.absoluteString, "width": width, "height": height, "pageWidthPt": Double(pw), "pageHeightPt": Double(ph)]
    }
  }

  private static func open(_ fileUri: String) throws -> PDFDocument {
    let url = fileUri.hasPrefix("file:") ? URL(string: fileUri) : URL(fileURLWithPath: fileUri)
    guard let url, let doc = PDFDocument(url: url) else { throw PdfException("not a readable PDF") }
    return doc
  }
}
