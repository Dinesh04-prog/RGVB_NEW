package com.nexuspos.app

import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
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
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
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
 * Each capture focuses first (unless the user just tapped to focus), and each photo is checked for blur,
 * darkness and glare; a problem is shown on the preview with "Retake" as the main button.
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
        private const val STATE_ISSUES = "issues"
        private const val FOCUS_TIMEOUT_MS = 1500L
        private const val TAP_FOCUS_VALID_MS = 3000L

        // App theme (nexus-react-pos App.tsx): primary blue, light blue, dark blue, green, grey
        private const val BLUE = 0xFF0D6EFD.toInt()
        private const val LIGHT_BLUE = 0xFFE7F1FF.toInt()
        private const val DARK_BLUE = 0xFF0A3D62.toInt()
        private const val GREEN = 0xFF16A34A.toInt()
        private const val GREY = 0xFF6C757D.toInt()
        private const val WARN_BG = 0xFFFFF9DB.toInt()
        private const val WARN_TEXT = 0xFF7A5D00.toInt()

        fun resultFile(ctx: Context) = File(ctx.filesDir, "scan_result.json")
        private fun photoFile(ctx: Context, n: Int) = File(ctx.cacheDir, "scan_photo_$n.jpg")
        private fun clearPhotos(ctx: Context) = (1..MAX_PHOTOS).forEach { photoFile(ctx, it).delete() }
    }

    private enum class Step { CAMERA, CHECKING, PREVIEW, PROCESSING }

    private var step = Step.CAMERA
    private var count = 0          // photos taken and kept
    private var torchOn = false
    private var issues: List<ImageQuality.Issue> = emptyList()   // of the last photo
    private var lastTapFocus = 0L
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
    private lateinit var retakeBtn: Button
    private lateinit var addAnotherBtn: Button
    private lateinit var progress: LinearLayout
    private lateinit var progressText: TextView
    private lateinit var geminiRow: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        if (savedInstanceState == null) {
            clearPhotos(this)
        } else {
            step = Step.valueOf(savedInstanceState.getString(STATE_STEP) ?: Step.CAMERA.name)
            count = savedInstanceState.getInt(STATE_COUNT)
            torchOn = savedInstanceState.getBoolean(STATE_TORCH)
            issues = savedInstanceState.getStringArrayList(STATE_ISSUES).orEmpty()
                .mapNotNull { n -> ImageQuality.Issue.values().firstOrNull { it.name == n } }
            if (step == Step.CHECKING) step = Step.PREVIEW   // the check was lost with the old Activity
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
        outState.putStringArrayList(STATE_ISSUES, ArrayList(issues.map { it.name }))
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
                    // ~12 MP: small inkjet print stays readable. Bigger sensors are subsampled when decoding for OCR.
                    .setResolutionSelector(ResolutionSelector.Builder()
                        .setResolutionStrategy(ResolutionStrategy(Size(4000, 3000),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
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

    /** Focus on the middle of the frame first (unless the user just tapped to focus), then take the photo. */
    private fun capture() {
        val ic = imageCapture ?: return
        val cam = camera ?: return
        if (count >= MAX_PHOTOS || step != Step.CAMERA) return
        captureBtn.isEnabled = false
        hint.text = "Focusing… hold steady."
        if (SystemClock.elapsedRealtime() - lastTapFocus < TAP_FOCUS_VALID_MS) { takePicture(ic); return }
        var taken = false
        val shoot = { if (!taken) { taken = true; takePicture(ic) } }
        val point = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.47f)
        val focus = cam.cameraControl.startFocusAndMetering(
            FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
                .setAutoCancelDuration(3, TimeUnit.SECONDS)
                .build()
        )
        focus.addListener({ shoot() }, ContextCompat.getMainExecutor(this))
        previewView.postDelayed({ shoot() }, FOCUS_TIMEOUT_MS)   // no autofocus / slow focus: take it anyway
    }

    private fun takePicture(ic: ImageCapture) {
        val file = photoFile(this, count + 1)
        ic.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    captureBtn.isEnabled = true
                    count++
                    checkPhoto(file)
                }
                override fun onError(e: ImageCaptureException) {
                    captureBtn.isEnabled = true
                    Log.e(TAG, "Capture failed", e)
                    Toast.makeText(this@ProductScanActivity, "Photo failed, try again", Toast.LENGTH_SHORT).show()
                    render()
                }
            })
    }

    /** Blur / dark / glare check on the worker thread, then the preview. */
    private fun checkPhoto(file: File) {
        step = Step.CHECKING
        issues = emptyList()
        render()
        worker.execute {
            val report = try { ScanPipeline.checkQuality(file) } catch (t: Throwable) { null }
            runOnUiThread {
                if (isFinishing || isDestroyed || step != Step.CHECKING) return@runOnUiThread
                issues = report?.issues.orEmpty()
                step = Step.PREVIEW
                render()
            }
        }
    }

    private fun focusAt(x: Float, y: Float) {
        val cam = camera ?: return
        val point = previewView.meteringPointFactory.createPoint(x, y)
        cam.cameraControl.startFocusAndMetering(
            FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
                .setAutoCancelDuration(3, TimeUnit.SECONDS)
                .build()
        )
        lastTapFocus = SystemClock.elapsedRealtime()
        guide.showFocus(x, y)
    }

    private fun toggleTorch() {
        torchOn = !torchOn
        camera?.cameraControl?.enableTorch(torchOn)
        updateTorchLabel()
    }

    private fun updateTorchLabel() { torchBtn.text = if (torchOn) "🔦 Torch off" else "🔦 Torch on" }

    // ── Steps ────────────────────────────────────────────────────────────────

    private fun render() {
        val previewing = step == Step.PREVIEW
        val checking = step == Step.CHECKING
        cameraBar.visibility = if (step == Step.CAMERA) View.VISIBLE else View.GONE
        geminiRow.visibility = if (step == Step.CAMERA && GeminiClient.configured()) View.VISIBLE else View.GONE
        previewBar.visibility = if (previewing) View.VISIBLE else View.GONE
        guide.visibility = if (step == Step.CAMERA) View.VISIBLE else View.GONE
        photoView.visibility = if (previewing) View.VISIBLE else View.GONE
        progress.visibility = if (checking) View.VISIBLE else View.GONE
        doneBtnCamera.visibility = if (count > 0) View.VISIBLE else View.GONE
        addAnotherBtn.visibility = if (count < MAX_PHOTOS) View.VISIBLE else View.GONE
        // A problem with the photo makes "Retake" the main button
        styleButton(retakeBtn, if (issues.isEmpty()) Style.SECONDARY else Style.PRIMARY)
        styleButton(addAnotherBtn, if (issues.isEmpty()) Style.PRIMARY else Style.SECONDARY)
        hint.setTextColor(GREY)
        hint.setBackgroundColor(Color.TRANSPARENT)
        when (step) {
            Step.CHECKING -> {
                title.text = "Photo $count/$MAX_PHOTOS"
                hint.text = ""
                progressText.text = "Checking the photo…"
            }
            Step.PREVIEW -> {
                if (issues.isEmpty()) {
                    title.text = "Photo $count/$MAX_PHOTOS: is the text sharp and readable?"
                    hint.text = if (count < MAX_PHOTOS) "You can add photos of the back, side and dates." else "That is the maximum of $MAX_PHOTOS photos."
                } else {
                    title.text = "Photo $count/$MAX_PHOTOS may be hard to read"
                    hint.text = issues.joinToString("\n") { it.message } + "\nTap Retake, or keep it if the text looks fine."
                    hint.setTextColor(WARN_TEXT)
                    hint.setBackgroundColor(WARN_BG)
                }
                photoView.setImageBitmap(ScanPipeline.loadBitmap(photoFile(this, count), 1280))
            }
            else -> {
                title.text = "Photo ${count + 1}/$MAX_PHOTOS"
                hint.text = when (count) {
                    0 -> "Front of the pack (name, brand) inside the frame."
                    else -> "Back or side: barcode, MRP, weight, dates. Tilt the pack if there is glare. Tap the text to focus."
                }
            }
        }
    }

    private fun addAnother() {
        photoView.setImageDrawable(null)
        issues = emptyList()
        step = Step.CAMERA
        render()
    }

    private fun retakeLast() {
        if (count > 0) { photoFile(this, count).delete(); count-- }
        photoView.setImageDrawable(null)
        issues = emptyList()
        step = Step.CAMERA
        render()
    }

    private fun handleBack() {
        when (step) {
            Step.PREVIEW -> addAnother()      // keep the photo, back to the camera
            Step.CAMERA -> finishCancelled()
            Step.CHECKING, Step.PROCESSING -> {}   // wait
        }
    }

    private fun startProcessing() {
        if (count == 0) return
        step = Step.PROCESSING
        cameraBar.visibility = View.GONE
        geminiRow.visibility = View.GONE
        previewBar.visibility = View.GONE
        guide.visibility = View.GONE
        photoView.visibility = View.GONE
        progress.visibility = View.VISIBLE
        title.text = if (count == 1) "Reading 1 photo…" else "Reading $count photos…"
        hint.text = ""
        progressText.text = "Reading barcode, name, MRP, weight and dates…"
        camera?.cameraControl?.enableTorch(false)
        cameraProvider?.unbindAll()

        val photos = (1..count).map { photoFile(this, it) }.filter { it.exists() }
        val appCtx = applicationContext
        worker.execute {
            val json = try {
                ScanPipeline.run(appCtx, photos)
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

    private enum class Style { PRIMARY, SECONDARY, SUCCESS }

    private fun styleButton(b: Button, style: Style) {
        val (bg, fg) = when (style) {
            Style.PRIMARY -> BLUE to Color.WHITE
            Style.SUCCESS -> GREEN to Color.WHITE
            Style.SECONDARY -> Color.WHITE to BLUE
        }
        b.background = GradientDrawable().apply {
            cornerRadius = dp(10).toFloat()
            setColor(bg)
            if (style == Style.SECONDARY) setStroke(dp(2), BLUE)
        }
        b.setTextColor(fg)
    }

    private fun bigButton(text: String, style: Style, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        textSize = 16f
        minHeight = dp(56)
        isAllCaps = false
        stateListAnimator = null
        styleButton(this, style)
        setOnClickListener { onClick() }
    }

    private fun weighted(w: Float) = LinearLayout.LayoutParams(0, WRAP_CONTENT, w).apply { setMargins(dp(4), 0, dp(4), 0) }

    private fun bar() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(dp(10), dp(10), dp(10), dp(16))
        setBackgroundColor(Color.WHITE)
        elevation = dp(4).toFloat()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }

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
            setBackgroundColor(Color.WHITE)
            visibility = View.GONE
        }
        root.addView(photoView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            elevation = dp(4).toFloat()
            setPadding(dp(16), dp(14), dp(16), dp(10))
        }
        title = TextView(this).apply { setTextColor(DARK_BLUE); textSize = 18f; setTypeface(typeface, android.graphics.Typeface.BOLD) }
        hint = TextView(this).apply { setTextColor(GREY); textSize = 14f; setPadding(0, dp(4), 0, dp(4)) }
        top.addView(title); top.addView(hint)

        // Gemini switch (persistent, default on) and the data note; only in builds with a Gemini Worker
        geminiRow = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = if (GeminiClient.configured()) View.VISIBLE else View.GONE
            addView(CheckBox(this@ProductScanActivity).apply {
                text = "Use Gemini when online"
                textSize = 14f
                setTextColor(DARK_BLUE)
                buttonTintList = ColorStateList.valueOf(BLUE)
                minHeight = dp(48)
                isChecked = GeminiClient.usedByUser(this@ProductScanActivity)
                setOnCheckedChangeListener { _, on -> GeminiClient.setUsedByUser(this@ProductScanActivity, on) }
            })
            addView(TextView(this@ProductScanActivity).apply {
                text = "Photos are read by Google Gemini when online."
                textSize = 12f
                setTextColor(GREY)
            })
        }
        top.addView(geminiRow)
        root.addView(top, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))

        cameraBar = bar()
        torchBtn = bigButton("🔦 Torch on", Style.SECONDARY) { toggleTorch() }
        captureBtn = bigButton("📸 Take photo", Style.PRIMARY) { capture() }
        doneBtnCamera = bigButton("✓ Done", Style.SUCCESS) { startProcessing() }
        cameraBar.addView(torchBtn, weighted(1.1f))
        cameraBar.addView(captureBtn, weighted(1.6f))
        cameraBar.addView(doneBtnCamera, weighted(1f))
        root.addView(cameraBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        previewBar = bar().apply { visibility = View.GONE }
        retakeBtn = bigButton("↺ Retake", Style.SECONDARY) { retakeLast() }
        addAnotherBtn = bigButton("+ Add another photo", Style.PRIMARY) { addAnother() }
        previewBar.addView(retakeBtn, weighted(1f))
        previewBar.addView(addAnotherBtn, weighted(1.3f))
        previewBar.addView(bigButton("✓ Done", Style.SUCCESS) { startProcessing() }, weighted(1f))
        root.addView(previewBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        progressText = TextView(this).apply {
            setTextColor(DARK_BLUE)
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(12), dp(24), 0)
        }
        progress = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
            visibility = View.GONE
            isClickable = true
            addView(ProgressBar(this@ProductScanActivity).apply { indeterminateTintList = ColorStateList.valueOf(BLUE) })
            addView(progressText)
        }
        root.addView(progress, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        top.bringToFront()

        setContentView(root)
        // Android 15+ draws under the status / navigation bars: keep the buttons clear of them
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    /** Dims everything outside the guide frame and shows a ring where the user tapped to focus. */
    private class GuideOverlay(ctx: Context) : View(ctx) {
        private val dim = Paint().apply { color = 0x66000000 }
        private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 6f
        }
        private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = LIGHT_BLUE; style = Paint.Style.STROKE; strokeWidth = 6f
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
