/**
 * WAV 音频拼接工具 — 将两个 WAV 文件中间插入指定长度的静音
 *
 * 用法: node concat-wav.js <文件1> <文件2> <静音毫秒> [输出文件名]
 */
import { readFileSync, writeFileSync } from 'fs';

const FILE1 = process.argv[2];
const FILE2 = process.argv[3];
const SILENCE_MS = parseInt(process.argv[4]) || 1000;
const OUTPUT = process.argv[5] || 'output.wav';

if (!FILE1 || !FILE2) {
  console.error('用法: node concat-wav.js <文件1> <文件2> <静音毫秒> [输出文件名]');
  process.exit(1);
}

function readWav(path) {
  const buf = readFileSync(path);
  // 标准 WAV: 44 字节 PCM header
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataOffset = 44; // 假设没有扩展块
  const data = buf.subarray(dataOffset);
  return { numChannels, sampleRate, bitsPerSample, data };
}

function writeWav(path, { numChannels, sampleRate, bitsPerSample, samples }) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = samples.length * bitsPerSample / 8 / numChannels; // 不对，需要按字节算
  // 简化：合并所有 data 段
  const rawData = Buffer.concat(samples);
  const dataSizeBytes = rawData.length;
  const buf = Buffer.alloc(44 + dataSizeBytes);

  // WAV header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSizeBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // chunk size
  buf.writeUInt16LE(1, 20);           // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // byte rate
  buf.writeUInt16LE(numChannels * bitsPerSample / 8, 32);              // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSizeBytes, 40);
  rawData.copy(buf, 44);

  writeFileSync(path, buf);
  console.log(`输出: ${path} (${(dataSizeBytes / 1024).toFixed(0)} KB)`);
}

console.log(`读取: ${FILE1} + ${FILE2} (静音 ${SILENCE_MS}ms)`);

const wav1 = readWav(FILE1);
const wav2 = readWav(FILE2);

// 验证格式兼容
if (wav1.sampleRate !== wav2.sampleRate || wav1.numChannels !== wav2.numChannels || wav1.bitsPerSample !== wav2.bitsPerSample) {
  console.error('错误: 两个 WAV 文件格式不兼容');
  console.error(`  文件1: ${wav1.sampleRate}Hz ${wav1.numChannels}ch ${wav1.bitsPerSample}bit`);
  console.error(`  文件2: ${wav2.sampleRate}Hz ${wav2.numChannels}ch ${wav2.bitsPerSample}bit`);
  process.exit(1);
}

// 生成静音数据
const bytesPerSample = wav1.bitsPerSample / 8;
const silenceFrames = Math.round(wav1.sampleRate * SILENCE_MS / 1000);
const silenceBytes = silenceFrames * wav1.numChannels * bytesPerSample;
const silence = Buffer.alloc(silenceBytes, 0); // PCM 静音就是 0

const samples = [wav1.data, silence, wav2.data];

writeWav(OUTPUT, {
  numChannels: wav1.numChannels,
  sampleRate: wav1.sampleRate,
  bitsPerSample: wav1.bitsPerSample,
  samples,
});

console.log(`  文件1: ${(wav1.data.length / 1024).toFixed(0)} KB`);
console.log(`  静音:  ${(silenceBytes / 1024).toFixed(0)} KB (${SILENCE_MS}ms)`);
console.log(`  文件2: ${(wav2.data.length / 1024).toFixed(0)} KB`);
console.log(`  合计:  ${((wav1.data.length + silenceBytes + wav2.data.length) / 1024).toFixed(0)} KB`);
