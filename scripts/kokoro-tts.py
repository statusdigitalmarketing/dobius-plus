#!/usr/bin/env python3
"""Dobius+ TTS wrapper around kokoro-onnx.

Reads UTF-8 text from stdin, writes 24 kHz 16-bit mono WAV to stdout.

Usage:
  echo "hello" | kokoro-tts.py [--voice af_bella] [--speed 1.0] [--lang en-us] \
    [--model <onnx>] [--voices <bin>]

Defaults match the Dobius Speak button on the Mac desktop: `af_bella` is a
warm American female voice. The model + voices live in ~/.samknows/models/kokoro/
unless overridden.

Keep this script short on purpose. It is spawned once per Speak press by
voice-playback.js, and the Python interpreter start dominates total latency.
Keeping the import graph tight (kokoro_onnx + sys only on the hot path) is
what lets a 2-sentence reply synthesize in under a second cold.
"""
import argparse
import os
import struct
import sys


def _write_wav_to_fd(fd, samples, sample_rate):
    """Write a mono 16-bit PCM WAV to the given file descriptor without
    going through a filename. soundfile cannot write to raw stdout on all
    platforms, so pack it ourselves."""
    import numpy as np
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767).astype('<i2').tobytes()
    data_size = len(pcm)
    header = b'RIFF' + struct.pack('<I', 36 + data_size) + b'WAVE'
    fmt = b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    data = b'data' + struct.pack('<I', data_size) + pcm
    os.write(fd, header + fmt + data)


def main():
    home = os.path.expanduser('~')
    parser = argparse.ArgumentParser()
    parser.add_argument('--voice', default='af_bella')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--lang', default='en-us')
    parser.add_argument('--model', default=os.path.join(home, '.samknows', 'models', 'kokoro', 'kokoro-v1.0.onnx'))
    parser.add_argument('--voices', default=os.path.join(home, '.samknows', 'models', 'kokoro', 'voices-v1.0.bin'))
    args = parser.parse_args()

    text = sys.stdin.read().strip()
    if not text:
        sys.stderr.write('no input text\n')
        sys.exit(2)

    if not os.path.isfile(args.model) or not os.path.isfile(args.voices):
        sys.stderr.write(f'missing model/voices at {args.model} or {args.voices}\n')
        sys.exit(3)

    try:
        from kokoro_onnx import Kokoro
    except ImportError as e:
        sys.stderr.write(f'kokoro-onnx not installed in this venv: {e}\n')
        sys.exit(4)

    k = Kokoro(args.model, args.voices)
    try:
        samples, sr = k.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
    except Exception as e:
        sys.stderr.write(f'synth failed: {e}\n')
        sys.exit(5)
    _write_wav_to_fd(1, samples, sr)


if __name__ == '__main__':
    main()
