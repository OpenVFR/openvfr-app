package expo.modules.openvfrpdf

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

/**
 * Renders one page of a PDF (or a crop of it) to a PNG file, with Android's own PdfRenderer: no third-party PDF library.
 * Used by the chart viewer and the georeferenced chart overlay (src/utils/charts.ts). The JS side checks the document and caps the
 * pixel count; this only draws. PdfRenderer allows one open page at a time, so calls are serialised.
 */
class OpenVfrPdfModule : Module() {
  private val lock = Any()

  override fun definition() = ModuleDefinition {
    Name("OpenVfrPdf")

    // { pageCount, widthPt, heightPt } of page `page` (1-based; page size in PDF points).
    AsyncFunction("pageInfo") { fileUri: String, page: Int ->
      synchronized(lock) {
        withRenderer(fileUri) { r ->
          if (page < 1 || page > r.pageCount) throw CodedException("ERR_PDF", "the document has no page $page", null)
          val p = r.openPage(page - 1)
          try {
            mapOf("pageCount" to r.pageCount, "widthPt" to p.width.toDouble(), "heightPt" to p.height.toDouble())
          } finally { p.close() }
        }
      }
    }

    // Draws page `page` (1-based), the part given by `crop` = [left, top, right, bottom] as page fractions, at width x height px, white
    // background, to the PNG file at `outUri`. Returns { uri, width, height, pageWidthPt, pageHeightPt }.
    AsyncFunction("renderPage") { fileUri: String, page: Int, width: Int, height: Int, crop: List<Double>, outUri: String ->
      if (width < 1 || height < 1 || crop.size != 4) throw CodedException("ERR_ARGS", "bad size or crop", null)
      synchronized(lock) {
        withRenderer(fileUri) { r ->
          if (page < 1 || page > r.pageCount) throw CodedException("ERR_PDF", "the document has no page $page", null)
          val p = r.openPage(page - 1)
          var bmp: Bitmap? = null
          try {
            val pw = p.width.toFloat()
            val ph = p.height.toFloat()
            val l = crop[0].toFloat(); val t = crop[1].toFloat(); val rt = crop[2].toFloat(); val b = crop[3].toFloat()
            val cropW = pw * (rt - l)
            val cropH = ph * (b - t)
            if (cropW <= 0f || cropH <= 0f) throw CodedException("ERR_ARGS", "empty crop", null)
            bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            bmp.eraseColor(Color.WHITE)
            // page points -> pixels: shift the crop origin to 0, then scale the crop to the bitmap.
            val m = Matrix()
            m.setScale(width / cropW, height / cropH)
            m.preTranslate(-l * pw, -t * ph)
            p.render(bmp, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val out = File(pathOf(outUri))
            out.parentFile?.mkdirs()
            FileOutputStream(out).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            mapOf(
              "uri" to Uri.fromFile(out).toString(), "width" to width, "height" to height,
              "pageWidthPt" to pw.toDouble(), "pageHeightPt" to ph.toDouble(),
            )
          } finally {
            bmp?.recycle()
            p.close()
          }
        }
      }
    }
  }

  private fun pathOf(uri: String): String = if (uri.startsWith("file:")) (Uri.parse(uri).path ?: uri) else uri

  private fun <T> withRenderer(fileUri: String, body: (PdfRenderer) -> T): T {
    val file = File(pathOf(fileUri))
    if (!file.isFile) throw CodedException("ERR_PDF", "no such file", null)
    val pfd = try {
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (e: Exception) {
      throw CodedException("ERR_PDF", "cannot open the file", e)
    }
    try {
      val renderer = try { PdfRenderer(pfd) } catch (e: Exception) { throw CodedException("ERR_PDF", "not a readable PDF", e) }
      try { return body(renderer) } finally { renderer.close() }
    } finally {
      pfd.close()
    }
  }
}
