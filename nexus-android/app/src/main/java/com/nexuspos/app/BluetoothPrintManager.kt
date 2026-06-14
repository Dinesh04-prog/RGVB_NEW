package com.nexuspos.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.widget.Toast
import java.io.OutputStream
import java.util.UUID

class BluetoothPrintManager(private val activity: MainActivity) {

    private val SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val adapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()

    private var socket: BluetoothSocket? = null
    private var output: OutputStream? = null

    // ── Device picker ─────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    fun showDevicePicker() {
        val paired = adapter?.bondedDevices?.toList() ?: emptyList()
        if (paired.isEmpty()) {
            Toast.makeText(
                activity,
                "No paired devices. Pair your Bluetooth printer in Android Settings first.",
                Toast.LENGTH_LONG
            ).show()
            callJs("window.onBtDeviceCancelled()")
            return
        }

        val names = paired.map { "${it.name ?: "Unknown"}\n${it.address}" }.toTypedArray()
        AlertDialog.Builder(activity)
            .setTitle("Select Bluetooth Printer")
            .setItems(names) { _, i -> connectDevice(paired[i].address) }
            .setOnCancelListener { callJs("window.onBtDeviceCancelled()") }
            .show()
    }

    // ── Connect (Classic BT / SPP) ─────────────────────────────────────────

    @SuppressLint("MissingPermission")
    fun connectDevice(address: String) {
        Thread {
            try {
                disconnect()
                val device: BluetoothDevice = adapter!!.getRemoteDevice(address)
                adapter.cancelDiscovery()
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                socket!!.connect()
                output = socket!!.outputStream

                val name = device.name ?: address
                callJs("window.onBtDeviceSelected(${name.toJsString()}, ${address.toJsString()})")
                callJs("window.onBtConnected()")
                toast("Connected to $name")
            } catch (e: Exception) {
                socket = null; output = null
                callJs("window.onBtConnectFailed(${e.message.toJsString()})")
                toast("Connection failed: ${e.message}")
            }
        }.start()
    }

    // ── Native text-mode print (UTF-8 ESC/POS — fast, like Zobaze) ───────────

    fun printBillNative(receiptJson: String) {
        if (output == null) {
            toast("No printer connected. Tap 'Connect Printer' first.")
            return
        }
        Thread {
            try {
                val json  = org.json.JSONObject(receiptJson)
                val bytes = EscPosPrinter.buildReceipt(json, activity)
                output?.write(bytes)
                output?.flush()
                toast("Printed ✓")
            } catch (e: Exception) {
                toast("Print failed: ${e.message}")
                handleDisconnect()
            }
        }.start()
    }

    // ── Write raw bytes (fallback for web-side ESC/POS) ────────────────────

    fun writeBytes(data: ByteArray) {
        Thread {
            try {
                output?.write(data)
                output?.flush()
            } catch (e: Exception) {
                toast("Print error: ${e.message}")
                handleDisconnect()
            }
        }.start()
    }

    // ── Disconnect ─────────────────────────────────────────────────────────

    fun disconnect() {
        try { output?.close() } catch (_: Exception) {}
        try { socket?.close() } catch (_: Exception) {}
        socket = null; output = null
    }

    private fun handleDisconnect() {
        disconnect()
        callJs("window.onBtDisconnected()")
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private fun callJs(script: String) {
        activity.runOnUiThread {
            activity.webView.evaluateJavascript("javascript:$script", null)
        }
    }

    private fun toast(msg: String) {
        activity.runOnUiThread { Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show() }
    }

    private fun String?.toJsString(): String {
        if (this == null) return "null"
        val escaped = replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        return "'$escaped'"
    }
}
