export const MAX_FILE_BYTES = 1024 ** 3;
export const MAX_PIXELS = 16_777_216;
export function validateFile(size) {
  if (size > MAX_FILE_BYTES) throw Error('源文件超过 1 GiB，请压缩文件后再试');
}
export function validateDimensions(w, h) {
  if (Math.min(w, h) < 16 || Math.max(w, h) > 16384 || w * h > MAX_PIXELS)
    throw Error('图片解码尺寸超出范围：至少 16×16，最多 1677 万像素，单边不超过 16384');
}
