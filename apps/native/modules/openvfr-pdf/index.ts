import { requireOptionalNativeModule } from 'expo'

/**
 * Native PDF page renderer (Android PdfRenderer, iOS PDFKit): see android/.../OpenVfrPdfModule.kt. OPTIONAL at runtime: a dev client
 * or build made before the module existed does not have it, and the app then falls back to opening charts in the system PDF viewer
 * (src/utils/charts.ts, `pdfRenderingAvailable`). Never import this for anything but that file.
 */
export interface PdfPageInfo { pageCount: number; widthPt: number; heightPt: number }
export interface RenderedPage { uri: string; width: number; height: number; pageWidthPt: number; pageHeightPt: number }

interface OpenVfrPdfNative {
  /** Size of one page (1-based) in PDF points, and the page count. */
  pageInfo(fileUri: string, page: number): Promise<PdfPageInfo>
  /** `crop` = [left, top, right, bottom] as fractions of the page; writes a PNG to `outUri`. */
  renderPage(fileUri: string, page: number, width: number, height: number, crop: number[], outUri: string): Promise<RenderedPage>
}

export const OpenVfrPdf = requireOptionalNativeModule<OpenVfrPdfNative>('OpenVfrPdf')
