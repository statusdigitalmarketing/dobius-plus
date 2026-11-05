import { useEffect, useRef, useState } from 'react';
import { parsePairingLink } from '../shared/pairing-link.js';

const SCANS_PER_SECOND = 8;
const SCAN_WIDTH = 640; // a QR filling a third of the view is still plenty of pixels

const NOT_OURS = 'That is not a Dobius+ pairing code. Scan the one under Settings › Mobile Access on your Mac.';
const TEAM_INVITE = 'That is a team invite. Those are pasted into Settings › Team on a Mac, not scanned here.';

function cameraMessage(err) {
  if (err?.name === 'NotAllowedError') return 'Camera access is off. Allow it in the Settings app under Dobius+, or enter the address instead.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No camera was found. Enter the address instead.';
  return 'The camera could not start. Enter the address instead.';
}

export const canScanQr = () => !!navigator.mediaDevices?.getUserMedia;

/** Full-screen camera that finds a Dobius+ pairing QR. Hands back { host, code }. Nothing leaves the phone. */
export default function QrScanner({ onResult, onCancel }) {
  const videoRef = useRef(null);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stream = null;
    let timer = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    (async () => {
      try {
        // Camera first and on its own: once the person has it, closing this screen or a
        // failed decoder download must always be able to turn it off.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        // The decoder is only needed on this screen, so it stays out of the main bundle.
        const { default: jsQR } = await import('jsqr');
        if (stopped) return;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        const scan = () => {
          if (stopped) return;
          if (video.videoWidth > 0) {
            const scale = Math.min(1, SCAN_WIDTH / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const found = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
            if (found?.data) {
              const link = parsePairingLink(found.data);
              if (link) { stopped = true; onResult(link); return; }
              setMessage(found.data.startsWith('dobius-team:') ? TEAM_INVITE : NOT_OURS);
            }
          }
          timer = setTimeout(scan, 1000 / SCANS_PER_SECOND);
        };
        scan();
      } catch (err) {
        stream?.getTracks().forEach((t) => t.stop());
        if (stopped) return;
        console.warn('[qr-scanner] camera failed:', err?.name, err?.message);
        setFailed(true);
        setMessage(cameraMessage(err));
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // onResult is read once per scanner: the screen closes on the first good code.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, []);

  return (
    <div className="qr-scanner" role="dialog" aria-label="Scan the QR code on your Mac">
      <video ref={videoRef} className="qr-video" playsInline muted autoPlay />
      {!failed && <div className="qr-frame" aria-hidden="true" />}
      <div className="qr-top">
        <p>Point your camera at the QR code under Settings › Mobile Access on your Mac.</p>
      </div>
      <div className="qr-bottom">
        {message && <p className="qr-message" role="status">{message}</p>}
        <button className="qr-cancel" onClick={onCancel}>{failed ? 'Enter the address' : 'Cancel'}</button>
      </div>
    </div>
  );
}
