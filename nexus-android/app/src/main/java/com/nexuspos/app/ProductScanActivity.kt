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
 * Step 1: front photo (name/brand, optional) → Step 2: back photo (barcode, MRP, size, dates, required)
 * → ScanPipeline on a background thread → result JSON written to [resultFile] → RESULT_OK.
 *
 * Survives being destroyed (low memory / process death): photos live in cacheDir, the step is saved in
 * onSaveInstanceState, and the result goes to a file that MainActivity / the web app pick up later.
 */
class ProductScanActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "NexusPOS"
        private const val REQ_CAMERA = 2001
        private const val STATE_STEP = "step"
        private const val STATE_FRONT_SKIPPED = "frontSkipped"
        private const val STATE_TORCH = "torch"

        fun resultFile(ctx: Context) = File(ctx.filesDir, "scan_result.json")
        private fun frontFile(ctx: Context) = File(ctx.cacheDir, "scan_front.jpg")
        private fun backFile(ctx: Context) = File(ctx.cacheDir, "scan_back.jpg")
    }

    private enum class Step { FRONT, FRONT_PREVIEW, BACK, BACK_PREVIEW, PROCESSING }

    private var step = Step.FRONT
    private var frontSkipped = false
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
    private lateinit var skipBtn: Button
    private lateinit var progress: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        savedInstanceState?.let {
            step = Step.valueOf(it.getString(STATE_STEP, Step.FRONT.name))
            frontSkipped = it.getBoolean(STATE_FRONT_SKIPPED)
            torchOn = it.getBoolean(STATE_TORCH)
        }
        if (savedInstanceState == null) {
            frontFile(this).delete()
            backFile(this).delete()
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })

        // A preview whose photo was cleaned up meanwhile falls back to the camera step
        if (step == Step.FRONT_PREVIEW && !frontFile(this).exists()) step = Step.FRONT
        if ((step == Step.BACK_PREVIEW || step == Step.PROCESSING) && !backFile(this).exists()) step = Step.BACK

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
        outState.putBoolean(STATE_FRONT_SKIPPED, frontSkipped)
        outState.putBoolean(STATE_TORCH, torchOn)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
        else {
            Toast.makeText(this, "Camera permission is needed to add items from photos", Toast.LENGTH_LONG).show()
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
        val file = if (step == Step.FRONT) frontFile(this) else backFile(this)
        captureBtn.isEnabled = false
        ic.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    captureBtn.isEnabled = true
                    step = if (step == Step.FRONT) Step.FRONT_PREVIEW else Step.BACK_PREVIEW
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
        val previewing = step == Step.FRONT_PREVIEW || step == Step.BACK_PREVIEW
        cameraBar.visibility = if (previewing) View.GONE else View.VISIBLE
        previewBar.visibility = if (previewing) View.VISIBLE else View.GONE
        guide.visibility = if (previewing) View.GONE else View.VISIBLE
        photoView.visibility = if (previewing) View.VISIBLE else View.GONE
        skipBtn.visibility = if (step == Step.FRONT) View.VISIBLE else View.GONE
        progress.visibility = View.GONE
        when (step) {
            Step.FRONT -> {
                title.text = "1/2  समोरचा फोटो (नाव / ब्रँड)"
                hint.text = "नाव आणि ब्रँड चौकटीत घ्या. हा फोटो ऐच्छिक आहे."
            }
            Step.BACK -> {
                title.text = "2/2  मागचा फोटो (बारकोड, MRP, वजन, Expiry)"
                hint.text = "बारकोड, MRP आणि तारीख चौकटीत घ्या. चमक येत असल्यास पाकीट थोडे तिरके धरा. अक्षरांवर टॅप करून फोकस करा."
            }
            Step.FRONT_PREVIEW, Step.BACK_PREVIEW -> {
                title.text = if (step == Step.FRONT_PREVIEW) "समोरचा फोटो ठीक आहे?" else "मागचा फोटो ठीक आहे? अक्षरे स्पष्ट दिसत आहेत?"
                hint.text = ""
                val file = if (step == Step.FRONT_PREVIEW) frontFile(this) else backFile(this)
                photoView.setImageBitmap(ScanPipeline.loadBitmap(file, 1280))
            }
            Step.PROCESSING -> {}
        }
    }

    private fun usePhoto() {
        if (step == Step.FRONT_PREVIEW) { step = Step.BACK; render() }
        else if (step == Step.BACK_PREVIEW) startProcessing()
    }

    private fun retake() {
        if (step == Step.FRONT_PREVIEW) { frontFile(this).delete(); step = Step.FRONT }
        if (step == Step.BACK_PREVIEW) { backFile(this).delete(); step = Step.BACK }
        photoView.setImageDrawable(null)
        render()
    }

    private fun skipFront() {
        frontSkipped = true
        frontFile(this).delete()
        step = Step.BACK
        render()
    }

    private fun handleBack() {
        when (step) {
            Step.FRONT_PREVIEW, Step.BACK_PREVIEW -> retake()
            Step.BACK -> { step = Step.FRONT; frontSkipped = false; render() }
            Step.FRONT -> finishCancelled()
            Step.PROCESSING -> {}   // wait for the result
        }
    }

    private fun startProcessing() {
        step = Step.PROCESSING
        cameraBar.visibility = View.GONE
        previewBar.visibility = View.GONE
        guide.visibility = View.GONE
        progress.visibility = View.VISIBLE
        title.text = "माहिती वाचत आहे…"
        hint.text = ""
        camera?.cameraControl?.enableTorch(false)
        cameraProvider?.unbindAll()

        val front = frontFile(this).takeIf { !frontSkipped && it.exists() }
        val back = backFile(this)
        val appCtx = applicationContext
        worker.execute {
            val json = try {
                ScanPipeline.run(front, back)
            } catch (t: Throwable) {
                Log.e(TAG, "Scan pipeline failed", t)
                try { ScanPipeline.emptyResult(front, back) } catch (_: Throwable) { null }
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
        textSize = 17f
        setTextColor(Color.WHITE)
        setBackgroundColor(color)
        minHeight = dp(60)
        isAllCaps = false
        setOnClickListener { onClick() }
    }

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
        skipBtn = bigButton("वगळा ⏭", grey) { skipFront() }
        val w = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { setMargins(dp(4), 0, dp(4), 0) }
        cameraBar.addView(torchBtn, w)
        cameraBar.addView(captureBtn, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1.6f).apply { setMargins(dp(4), 0, dp(4), 0) })
        cameraBar.addView(skipBtn, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { setMargins(dp(4), 0, dp(4), 0) })
        root.addView(cameraBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        previewBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), dp(10), dp(10), dp(16))
            setBackgroundColor(0x99000000.toInt())
            visibility = View.GONE
        }
        previewBar.addView(bigButton("↺ पुन्हा घ्या", blue) { retake() },
            LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { setMargins(dp(4), 0, dp(4), 0) })
        previewBar.addView(bigButton("✓ हा फोटो वापरा", green) { usePhoto() },
            LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { setMargins(dp(4), 0, dp(4), 0) })
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
