import { describe, it, expect, vi } from "vitest";
import { detectFaces, getPrimaryFace, hasSingleFace, hasMultipleFaces, hasNoFaces } from "@/lib/face/face-detector";

describe("Face Detector", () => {
  it("handles empty or invalid inputs gracefully", async () => {
    const result = await detectFaces(new Blob([], { type: "image/png" }));
    expect(result).toBeNull();
  });

  it("correctly evaluates face count helpers", () => {
    const emptyResult = { faces: [], imageWidth: 100, imageHeight: 100 };
    expect(hasNoFaces(emptyResult)).toBe(true);
    expect(hasSingleFace(emptyResult)).toBe(false);
    expect(hasMultipleFaces(emptyResult)).toBe(false);
    expect(getPrimaryFace(emptyResult)).toBeNull();

    const singleResult = {
      faces: [
        {
          x: 0.2,
          y: 0.2,
          width: 0.5,
          height: 0.5,
          confidence: 0.9,
          pixelBox: { x: 20, y: 20, width: 50, height: 50 },
        },
      ],
      imageWidth: 100,
      imageHeight: 100,
    };
    expect(hasNoFaces(singleResult)).toBe(false);
    expect(hasSingleFace(singleResult)).toBe(true);
    expect(hasMultipleFaces(singleResult)).toBe(false);
    expect(getPrimaryFace(singleResult)?.confidence).toBe(0.9);

    const multiResult = {
      faces: [
        {
          x: 0.1,
          y: 0.1,
          width: 0.3,
          height: 0.3,
          confidence: 0.8,
          pixelBox: { x: 10, y: 10, width: 30, height: 30 },
        },
        {
          x: 0.5,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          confidence: 0.95,
          pixelBox: { x: 50, y: 50, width: 40, height: 40 },
        },
      ],
      imageWidth: 100,
      imageHeight: 100,
    };
    expect(hasNoFaces(multiResult)).toBe(false);
    expect(hasSingleFace(multiResult)).toBe(false);
    expect(hasMultipleFaces(multiResult)).toBe(true);
    // Primary face should be the largest by area (Face 2: 0.4*0.4 = 0.16 vs Face 1: 0.3*0.3 = 0.09)
    expect(getPrimaryFace(multiResult)?.pixelBox.width).toBe(40);
  });
});