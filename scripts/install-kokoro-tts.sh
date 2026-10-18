#!/bin/bash
# Install the Kokoro TTS engine for Dobius+ Speak button.
#
# Sets up a dedicated Python 3.13 venv at ~/.dobius-tts-venv and installs
# kokoro-onnx + soundfile. The model files are expected at
# ~/.samknows/models/kokoro/{kokoro-v1.0.onnx, voices-v1.0.bin} (SamKnows ships
# these; download them from https://github.com/thewh1teagle/kokoro-onnx if not
# present).
#
# After install, voice-playback.js's activeEngine() detection picks up Kokoro
# automatically on the next Speak press. Nothing in Dobius+ needs to restart.
set -e

VENV="$HOME/.dobius-tts-venv"
PY313="/opt/homebrew/bin/python3.13"
MODEL_DIR="$HOME/.samknows/models/kokoro"

if [ ! -x "$PY313" ]; then
  echo "python3.13 not found at $PY313"
  echo "install with: brew install python@3.13"
  exit 1
fi

if [ ! -f "$MODEL_DIR/kokoro-v1.0.onnx" ] || [ ! -f "$MODEL_DIR/voices-v1.0.bin" ]; then
  echo "Kokoro model files missing in $MODEL_DIR"
  echo "they look like:"
  echo "  kokoro-v1.0.onnx    (~310 MB)"
  echo "  voices-v1.0.bin     (~27 MB)"
  echo "download from https://github.com/thewh1teagle/kokoro-onnx/releases"
  exit 2
fi

if [ ! -d "$VENV" ]; then
  echo "creating venv at $VENV"
  "$PY313" -m venv "$VENV"
fi

echo "installing kokoro-onnx + soundfile"
"$VENV/bin/pip" install --quiet --upgrade kokoro-onnx soundfile

echo "smoke test"
echo "Kokoro TTS install complete." | "$VENV/bin/python" "$(dirname "$0")/kokoro-tts.py" --voice af_bella > /tmp/kokoro-install-test.wav
if [ -s /tmp/kokoro-install-test.wav ]; then
  echo "ok. Dobius+ Speak button will use Kokoro on the next press."
  afplay /tmp/kokoro-install-test.wav
else
  echo "smoke test failed, see stderr above"
  exit 3
fi
