// 图片是用户消息的一部分,不经 OCR 或路径占位替代。
export type ImageInput = {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  name?: string;
};

export function imageDataUrl(image: ImageInput): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function imageBytes(image: ImageInput): number {
  return Buffer.byteLength(image.data, "base64");
}

export function imageSummary(images?: readonly ImageInput[]): string {
  return images?.length
    ? images
        .map(
          (image, i) =>
            `[Image ${i + 1}: ${image.name ?? image.mimeType}, ${imageBytes(image)} bytes]`,
        )
        .join("\n")
    : "";
}
