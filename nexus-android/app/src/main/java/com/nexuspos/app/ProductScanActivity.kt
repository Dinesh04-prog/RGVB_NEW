package com.nexuspos.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.Bundle
import android.util.Log
import android.util.Size
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Take 1–5 photos of one pack (front, back, side, crimp…), then "Done" → ScanPipeline on a background
 * thread → result JSON written to [resultFile] → RESULT_OK. Photos never leave this screen.
 *
 * Survives being destroyed (low memory / process death): photos live in cacheDir, the photo count and step
 * are saved in onSaveInstanceState, and the result goes to a file that MainActivity / the web app pick up.
 */
class ProductScanActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "NexusPOS"
        private const val REQ_CAMERA = 2001
        const val MAX_PHOTOS = 5
        private const val STATE_STEP = "step"
        private const val STATE_COUNT = "count"
        private const val STATE_TORCH = "torch"

        fun resultFile(ctx: Context) = File(ctx.filesDir, "scan_result.json")
        private fun photoFile(ctx: Context, n: Int) = File(ctx.cacheDir, "scan_photo_$n.jpg")
        private fun clearPhotos(ctx: Context) = (1..MAX_PHOTOS).forEach { photoFile(ctx, it).delete() }
    }

    private enum class Step { CAMERA, PREVIEW, PROCESSING }

    private var step = Step.CAMERA
    private var count = 0          // photos taken and kept
    private var torchOn = false
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private val worker = Executors.newSingleThreadExecutor()

    private lateinit var previewView: PreviewView
    private lateinit var guide: GuideOverlay
    private lateinit var photoView: ImageView
    private lateinit var title: TextView
    private lateinit var hint: TextView
    private lateinit var cameraBar: LinearLayout
    private lateinit var previewBar: LinearLayout
    private lateinit var captureBtn: Button
    private lateinit var torchBtn: Button
    private lateinit var doneBtnCamera: Button
    private lateinit var addAnotherBtn: Button
    private lateinit var progress: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        if (savedInstanceState == null) {
            clearPhotos(this)
        } else {
            step = Step.valueOf(savedInstanceState.getString(STATE_STEP) ?: Step.CAMERA.name)
            count = savedInstanceState.getInt(STATE_COUNT)
            torchOn = savedInstanceState.getBoolean(STATE_TORCH)
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })

        // Photos cleaned up meanwhile (cache cleared): keep only the ones that still exist
        while (count > 0 && !photoFile(this, count).exists()) count--
        if (count == 0 && step != Step.CAMERA) step = Step.CAMERA

        if (step == Step.PROCESSING) { startProcessing(); return }
        render()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_STEP, step.name)
        outState.putInt(STATE_COUNT, count)
        outState.putBoolean(STATE_TORCH, torchOn)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
        else {
            Toast.makeText(this, "Camera permission is needed to fill items from photos", Toast.LENGTH_LONG).show()
            finishCancelled()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        worker.shutdown()   // a running scan finishes; no new work is accepted
    }

    // ── Camera ───────────────────────────────────────────────────────────────

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                cameraProvider = provider
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                    // ~5 MP is plenty for OCR and keeps memory low on cheap phones
                    .setResolutionSelector(ResolutionSelector.Builder()
                        .setResolutionStrategy(ResolutionStrategy(Size(2592, 1944),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                        .build())
                    .build()
                provider.unbindAll()
                val cam = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture)
                camera = cam
                imageCapture = capture
                torchBtn.visibility = if (cam.cameraInfo.hasFlashUnit()) View.VISIBLE else View.GONE
                if (torchOn) cam.cameraControl.enableTorch(true)
                updateTorchLabel()
            } catch (e: Exception) {
                Log.e(TAG, "Camera start failed", e)
                Toast.makeText(this, "Camera could not start: ${e.message}", Toast.LENGTH_LONG).show()
                finishCancelled()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun capture() {
        val ic = imageCapture ?: return
        if (count >= MAX_PHOTOS) return
        val file = photoFile(this, count + 1)
        captureBtn.isEnabled = false
        ic.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    captureBtn.isEnabled = true
                    count++
                    step = Step.PREVIEW
                    render()
                }
                override fun onError(e: ImageCaptureException) {
                    captureBtn.isEnabled = true
                    Log.e(TAG, "Capture failed", e)
                    Toast.makeText(this@ProductScanActivity, "Photo failed, try again", Toast.LENGTH_SHORT).show()
                }
            })
    }

    private fun focusAt(x: Float, y: Float) {
        val cam = camera ?: return
        val point = previewView.meteringPointFactory.createPoint(x, y)
        cam.cameraControl.startFocusAndMetering(
            FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
                .setAutoCancelDuration(3, TimeUnit.SECONDS)
                .build()
        )
        guide.showFocus(x, y)
    }

    private fun toggleTorch() {
        torchOn = !torchOn
        camera?.cameraControl?.enableTorch(torchOn)
        updateTorchLabel()
    }

    private fun updateTorchLabel() { torchBtn.text = if (torchOn) "🔦 बंद" else "🔦 चालू" }

    // ── Steps ────────────────────────────────────────────────────────────────

    private fun render() {
        val previewing = step == Step.PREVIEW
        cameraBar.visibility = if (previewing) View.GONE else View.VISIBLE
        previewBar.visibility = if (previewing) View.VISIBLE else View.GONE
        guide.visibility = if (previewing) View.GONE else View.VISIBLE
        photoView.visibility = if (previewing) View.VISIBLE else View.GONE
        progress.visibility = View.GONE
        doneBtnCamera.visibility = if (count > 0) View.VISIBLE else View.GONE
        addAnotherBtn.visibility = if (count < MAX_PHOTOS) View.VISIBLE else View.GONE
        if (previewing) {
            title.text = "फोटो $count/$MAX_PHOTOS ठीक आहे? अक्षरे स्पष्ट दिसत आहेत?"
            hint.text = if (count < MAX_PHOTOS) "बाजू, मागचा भाग, तारीख यांचे आणखी फोटो घेऊ शकता." else "जास्तीत जास्त $MAX_PHOTOS फोटो झाले."
            photoView.setImageBitmap(ScanPipeline.loadBitmap(photoFile(this, count), 1280))
        } else {
            title.text = "फोटो ${count + 1}/$MAX_PHOTOS"
            hint.text = when (count) {
                0 -> "समोरचा भाग (नाव, ब्रँड) चौकटीत घ्या."
                else -> "मागचा भाग: बारकोड, MRP, वजन, तारीख. चमक येत असल्यास पाकीट थोडे तिरके धरा. अक्षरांवर टॅप करून फोकस करा."
            }
        }
    }

    private fun addAnother() {
        photoView.setImageDrawable(null)
        step = Step.CAMERA
        render()
    }

    private fun retakeLast() {
        if (count > 0) { photoFile(this, count).delete(); count-- }
        photoView.setImageDrawable(null)
        step = Step.CAMERA
        render()
    }

    private fun handleBack() {
        when (step) {
            Step.PREVIEW -> addAnother()      // keep the photo, back to the camera
            Step.CAMERA -> finishCancelled()
            Step.PROCESSING -> {}             // wait for the result
        }
    }

    private fun startProcessing() {
        if (count == 0) return
        step = Step.PROCESSING
        cameraBar.visibility = View.GONE
        previewBar.visibility = View.GONE
        guide.visibility = View.GONE
        photoView.visibility = View.GONE
        progress.visibility = View.VISIBLE
        title.text = "$count फोटोंमधून माहिती वाचत आहे…"
        hint.text = ""
        camera?.cameraControl?.enableTorch(false)
        cameraProvider?.unbindAll()

        val photos = (1..count).map { photoFile(this, it) }.filter { it.exists() }
        val appCtx = applicationContext
        worker.execute {
            val json = try {
                ScanPipeline.run(photos)
            } catch (t: Throwable) {
                Log.e(TAG, "Scan pipeline failed", t)
                try { ScanPipeline.emptyResult(photos.size, t.javaClass.simpleName) } catch (_: Throwable) { null }
            }
            if (json != null) {
                val tmp = File(appCtx.filesDir, "scan_result.tmp")
                tmp.writeText(json.toString())
                tmp.renameTo(resultFile(appCtx))
            }
            // Photos stay until the next scan starts: a re-run after Activity recreation may still need them.
            runOnUiThread {
                if (!isFinishing && !isDestroyed) {
                    setResult(if (json != null) RESULT_OK else RESULT_CANCELED)
                    finish()
                }
            }
        }
    }

    private fun finishCancelled() {
        setResult(RESULT_CANCELED)
        finish()
    }

    // ── UI (built in code; no XML layout) ────────────────────────────────────

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun bigButton(text: String, color: Int, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        textSize = 16f
        setTextColor(Color.WHITE)
        setBackgroundColor(color)
        minHeight = dp(60)
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun weighted(w: Float) = LinearLayout.LayoutParams(0, WRAP_CONTENT, w).apply { setMargins(dp(4), 0, dp(4), 0) }

    @SuppressLint("ClickableViewAccessibility")
    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        previewView = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            setOnTouchListener { v, ev ->
                if (ev.action == MotionEvent.ACTION_UP) { focusAt(ev.x, ev.y); v.performClick() }
                true
            }
        }
        root.addView(previewView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        guide = GuideOverlay(this)
        root.addView(guide, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        photoView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        root.addView(photoView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0x99000000.toInt())
            setPadding(dp(16), dp(14), dp(16), dp(10))
        }
        title = TextView(this).apply { setTextColor(Color.WHITE); textSize = 18f }
        hint = TextView(this).apply { setTextColor(0xFFFDE68A.toInt()); textSize = 14f }
        top.addView(title); top.addView(hint)
        root.addView(top, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))

        val blue = 0xFF0A3D62.toInt()
        val green = 0xFF16A34A.toInt()
        val grey = 0xFF4B5563.toInt()
        val orange = 0xFFF97316.toInt()

        cameraBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), dp(10), dp(10), dp(16))
            setBackgroundColor(0x99000000.toInt())
        }
        torchBtn = bigButton("🔦 चालू", grey) { toggleTorch() }
        captureBtn = bigButton("📸 फोटो घ्या", orange) { capture() }
        doneBtnCamera = bigButton("✓ झाले", green) { startProcessing() }
        cameraBar.addView(torchBtn, weighted(1f))
        cameraBar.addView(captureBtn, weighted(1.6f))
        cameraBar.addView(doneBtnCamera, weighted(1f))
        root.addView(cameraBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        previewBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), dp(10), dp(10), dp(16))
            setBackgroundColor(0x99000000.toInt())
            visibility = View.GONE
        }
        addAnotherBtn = bigButton("+ आणखी फोटो", blue) { addAnother() }
        previewBar.addView(bigButton("↺ पुन्हा घ्या", grey) { retakeLast() }, weighted(1f))
        previewBar.addView(addAnotherBtn, weighted(1.2f))
        previewBar.addView(bigButton("✓ झाले", green) { startProcessing() }, weighted(1f))
        root.addView(previewBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        progress = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xCC000000.toInt())
            visibility = View.GONE
            isClickable = true
            addView(ProgressBar(this@ProductScanActivity))
            addView(TextView(this@ProductScanActivity).apply {
                text = "बारकोड, MRP, तारीख वाचत आहे…"
                setTextColor(Color.WHITE)
                textSize = 16f
                setPadding(0, dp(12), 0, 0)
            })
        }
        root.addView(progress, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        setContentView(root)
    }

    /** Dims everything outside the guide frame and shows a ring where the user tapped to focus. */
    private class GuideOverlay(ctx: Context) : View(ctx) {
        private val dim = Paint().apply { color = 0x88000000.toInt() }
        private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 6f
        }
        private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFFFDE68A.toInt(); style = Paint.Style.STROKE; strokeWidth = 5f
        }
        private var focusX = -1f
        private var focusY = -1f

        fun showFocus(x: Float, y: Float) {
            focusX = x; focusY = y
            invalidate()
            postDelayed({ focusX = -1f; invalidate() }, 900)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val w = width.toFloat()
            val h = height.toFloat()
            val rect = RectF(w * 0.07f, h * 0.22f, w * 0.93f, h * 0.72f)
            val r = 24f
            val path = Path().apply {
                fillType = Path.FillType.EVEN_ODD
                addRect(0f, 0f, w, h, Path.Direction.CW)
                addRoundRect(rect, r, r, Path.Direction.CW)
            }
            canvas.drawPath(path, dim)
            canvas.drawRoundRect(rect, r, r, frame)
            if (focusX >= 0) canvas.drawCircle(focusX, focusY, 60f, ring)
        }
    }
}
