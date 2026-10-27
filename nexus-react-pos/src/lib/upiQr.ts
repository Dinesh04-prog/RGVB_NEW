// UPI payment QR for a bill: any UPI app (GPay, PhonePe, Paytm, BHIM) scans it and fills in the shop and the amount.
import qrcode from 'qrcode-generator';

/** upi://pay link with the shop's UPI ID, name, the bill amount and the bill number as the note. */
export const upiPayLink = (upiId: string, payeeName: string, amount: number, note: string) =>
  `upi://pay?pa=${upiId.trim()}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;

/** The QR drawn on a white canvas about `size` px wide (black modules, 4-module quiet zone). */
export const qrCanvas = (text: string, size = 240): HTMLCanvasElement => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.max(2, Math.floor(size / (n + quiet * 2)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cell * (n + quiet * 2);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }
  return canvas;
};

/** PNG data URL of the QR (for <img>, the printed receipt and the Android printer). */
export const qrDataUrl = (text: string, size = 240) => qrCanvas(text, size).toDataURL('image/png');
