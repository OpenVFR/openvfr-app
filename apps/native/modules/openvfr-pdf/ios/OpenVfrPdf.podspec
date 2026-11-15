Pod::Spec.new do |s|
  s.name           = 'OpenVfrPdf'
  s.version        = '1.0.0'
  s.summary        = 'Renders a PDF page to a PNG (chart viewer and overlay)'
  s.description    = 'Renders a page of a PDF, or a crop of it, to a PNG file with PDFKit.'
  s.license        = 'MIT'
  s.author         = 'OpenVFR'
  s.homepage       = 'https://github.com/OpenVFR/openvfr-app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/OpenVFR/openvfr-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
