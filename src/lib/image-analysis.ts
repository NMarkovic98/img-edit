// src/lib/image-analysis.ts
// Enterprise-grade image quality analysis using sharp.
// Runs on the buffer we already fetch for dimension detection — zero extra cost.
//
// Analyses performed (all from pixel statistics, no AI calls):
//  1. Exposure (brightness)         — dark / overexposed
//  2. Contrast (stdev)              — flat / faded
//  3. Saturation (HSL)              — washed-out colors
//  4. Color cast (channel deviation) — warm/cool/green/magenta shift
//  5. Dynamic range (min/max)       — clipped highlights or crushed shadows
//  6. Highlight clipping            — percentage of blown-out whites
//  7. Shadow clipping               — percentage of crushed blacks
//  8. Color temperature              — warm/cool beyond simple cast
//  9. Tonal compression             — midtones bunched together
// 10. Sharpness                     — soft/blurry detection via Laplacian energy
// 11. Noise estimation              — high-frequency noise level
// 12. Vignetting                    — dark edges vs bright center
import sharp from "sharp";

export interface ImageIssues {
  /** Hints to append to the editing prompt */
  hints: string[];
  /** Short log summary */
  summary: string;
  /** Raw metrics for debugging / UI display */
  metrics: Record<string, number>;
}

/**
 * Analyze an image buffer for quality issues.
 * Returns prompt hints a professional retoucher would apply.
 */
export async function analyzeImageQuality(buf: Buffer): Promise<ImageIssues> {
  const hints: string[] = [];
  const issues: string[] = [];
  const metrics: Record<string, number> = {};

  try {
    // =====================================================================
    // Pass 1: Global RGB statistics
    // =====================================================================
    const { channels } = await sharp(buf).stats();

    if (!channels || channels.length < 3) {
      return {
        hints: [],
        summary: "Could not analyze (not enough channels)",
        metrics: {},
      };
    }

    const [r, g, b] = channels;

    // -------------------------------------------------------------------
    // 1. EXPOSURE — average brightness (0-255)
    // -------------------------------------------------------------------
    const brightness = (r.mean + g.mean + b.mean) / 3;
    metrics.brightness = Math.round(brightness);

    if (brightness < 50) {
      issues.push(`very dark (${brightness.toFixed(0)})`);
      hints.push(
        "The image is very dark and underexposed. Lift exposure significantly, open up shadows, and recover midtone detail while protecting highlights.",
      );
    } else if (brightness < 80) {
      issues.push(`underexposed (${brightness.toFixed(0)})`);
      hints.push(
        "The image is underexposed. Gently increase exposure and lift shadow regions to reveal hidden detail.",
      );
    } else if (brightness > 215) {
      issues.push(`heavily overexposed (${brightness.toFixed(0)})`);
      hints.push(
        "The image is heavily overexposed with likely blown highlights. Pull down exposure, recover highlight detail, and restore midtone separation.",
      );
    } else if (brightness > 185) {
      issues.push(`slightly bright (${brightness.toFixed(0)})`);
      hints.push(
        "The image is slightly overexposed. Tone down highlights gently and add micro-contrast in the midtones.",
      );
    }

    // -------------------------------------------------------------------
    // 2. CONTRAST — average channel stdev
    //    Normal well-exposed photo: 45-70. Flat/faded: <30.
    // -------------------------------------------------------------------
    const contrast = (r.stdev + g.stdev + b.stdev) / 3;
    metrics.contrast = Math.round(contrast * 10) / 10;

    if (contrast < 20) {
      issues.push(`very flat (stdev=${contrast.toFixed(1)})`);
      hints.push(
        "The image is extremely flat with almost no tonal separation. Apply a strong S-curve: deepen blacks, boost midtone contrast, and brighten highlights to restore tonal depth.",
      );
    } else if (contrast < 30) {
      issues.push(`low contrast (stdev=${contrast.toFixed(1)})`);
      hints.push(
        "The image lacks contrast and looks faded. Add a subtle S-curve contrast boost — deepen shadows slightly and lift highlights for more punch.",
      );
    } else if (contrast < 38) {
      issues.push(`slightly flat (stdev=${contrast.toFixed(1)})`);
      hints.push(
        "The image could use a touch more contrast. Add slight midtone contrast for better depth.",
      );
    }

    // -------------------------------------------------------------------
    // 3. SATURATION — HSL analysis of mean RGB
    // -------------------------------------------------------------------
    const maxC = Math.max(r.mean, g.mean, b.mean) / 255;
    const minC = Math.min(r.mean, g.mean, b.mean) / 255;
    const lum = (maxC + minC) / 2;
    const sat =
      maxC === minC
        ? 0
        : lum > 0.5
          ? (maxC - minC) / (2 - maxC - minC)
          : (maxC - minC) / (maxC + minC);

    metrics.saturation = Math.round(sat * 100);

    const channelSpread =
      Math.max(r.mean, g.mean, b.mean) - Math.min(r.mean, g.mean, b.mean);
    const isIntentionalBW = sat < 0.06 && channelSpread < 10;

    if (!isIntentionalBW) {
      if (sat < 0.1) {
        issues.push(`severely desaturated (${(sat * 100).toFixed(0)}%)`);
        hints.push(
          "The colors are severely washed out. Significantly boost vibrance and saturation — bring life back to skin tones, foliage, and sky without oversaturating primary colors.",
        );
      } else if (sat < 0.16) {
        issues.push(`low saturation (${(sat * 100).toFixed(0)}%)`);
        hints.push(
          "The colors are muted and lack vibrancy. Boost vibrance (selective saturation) to make colors pop naturally without oversaturating skin tones.",
        );
      } else if (sat > 0.65) {
        issues.push(`oversaturated (${(sat * 100).toFixed(0)}%)`);
        hints.push(
          "The image appears oversaturated with unnaturally vivid colors. Reduce saturation slightly for a more natural, balanced look.",
        );
      }
    }

    // -------------------------------------------------------------------
    // 4. COLOR CAST — channel deviation from neutral gray
    // -------------------------------------------------------------------
    const avgMean = (r.mean + g.mean + b.mean) / 3;
    const rDev = (r.mean - avgMean) / avgMean;
    const gDev = (g.mean - avgMean) / avgMean;
    const bDev = (b.mean - avgMean) / avgMean;
    metrics.rDeviation = Math.round(rDev * 100);
    metrics.gDeviation = Math.round(gDev * 100);
    metrics.bDeviation = Math.round(bDev * 100);

    if (
      Math.abs(rDev) > 0.12 ||
      Math.abs(gDev) > 0.12 ||
      Math.abs(bDev) > 0.12
    ) {
      // Determine specific cast type
      let castType: string;
      let correction: string;

      if (rDev > 0.12 && bDev < -0.08) {
        castType = "warm yellow/orange";
        correction =
          "Shift white balance cooler — reduce yellow/orange tint and add subtle blue to neutralize.";
      } else if (bDev > 0.12 && rDev < -0.08) {
        castType = "cool blue";
        correction =
          "Shift white balance warmer — reduce blue tint and add subtle warmth to neutralize.";
      } else if (gDev > 0.12) {
        castType = "green";
        correction =
          "Remove the green color cast — add magenta to neutralize. Common under fluorescent lighting.";
      } else if (gDev < -0.12 && rDev > 0.06) {
        castType = "magenta/pink";
        correction =
          "Remove the magenta tint — add slight green to neutralize.";
      } else if (rDev > 0.12) {
        castType = "red";
        correction =
          "Reduce the red color cast — cool down the image and add slight cyan.";
      } else if (bDev > 0.12) {
        castType = "blue";
        correction =
          "Reduce the blue cast — warm the shadows and add subtle yellow.";
      } else {
        castType = "mixed";
        correction = "Correct the white balance to achieve neutral tones.";
      }

      issues.push(`color cast: ${castType}`);
      hints.push(`The image has a ${castType} color cast. ${correction}`);
    }

    // -------------------------------------------------------------------
    // 5. DYNAMIC RANGE — channel min/max analysis
    //    Clipped means lost detail in highlights or shadows.
    // -------------------------------------------------------------------
    const globalMin = Math.min(r.min, g.min, b.min);
    const globalMax = Math.max(r.max, g.max, b.max);
    const dynamicRange = globalMax - globalMin;
    metrics.dynamicRange = dynamicRange;
    metrics.globalMin = globalMin;
    metrics.globalMax = globalMax;

    if (dynamicRange < 120) {
      issues.push(`compressed dynamic range (${dynamicRange})`);
      hints.push(
        "The image has a very compressed dynamic range — detail is lost in both extremes. Expand the tonal range: stretch blacks toward 0 and whites toward 255 while preserving midtone detail.",
      );
    }

    // -------------------------------------------------------------------
    // 6. HIGHLIGHT CLIPPING — estimate % near-white pixels
    //    If R, G, B all have high max but low stdev near the top, highlights
    //    are likely blown. We approximate from stats.
    // -------------------------------------------------------------------
    // Use the relationship between mean, stdev, and max to estimate clipping
    // If mean is high AND stdev is low AND max is at 255 → clipped highlights
    const rHighClip = r.max >= 254 && r.mean > 200 && r.stdev < 30;
    const gHighClip = g.max >= 254 && g.mean > 200 && g.stdev < 30;
    const bHighClip = b.max >= 254 && b.mean > 200 && b.stdev < 30;
    const highlightClipped = [rHighClip, gHighClip, bHighClip].filter(
      Boolean,
    ).length;

    if (highlightClipped >= 2) {
      issues.push("blown highlights");
      hints.push(
        "Highlights are blown out (clipped to pure white). Try to recover highlight detail and add subtle graduation in the brightest areas.",
      );
    }

    // -------------------------------------------------------------------
    // 7. SHADOW CLIPPING — estimate crushed blacks
    // -------------------------------------------------------------------
    const rLowClip = r.min <= 1 && r.mean < 50 && r.stdev < 25;
    const gLowClip = g.min <= 1 && g.mean < 50 && g.stdev < 25;
    const bLowClip = b.min <= 1 && b.mean < 50 && b.stdev < 25;
    const shadowClipped = [rLowClip, gLowClip, bLowClip].filter(Boolean).length;

    if (shadowClipped >= 2) {
      issues.push("crushed shadows");
      hints.push(
        "Shadow detail is crushed to pure black. Lift the black point slightly and open up shadow detail without making the image look washed out.",
      );
    }

    // -------------------------------------------------------------------
    // 8. COLOR TEMPERATURE — more nuanced warm/cool analysis
    //    Based on red-blue balance (independent of green channel).
    // -------------------------------------------------------------------
    const colorTemp = r.mean - b.mean; // positive = warm, negative = cool
    metrics.colorTemp = Math.round(colorTemp);

    // Only flag if not already caught by color cast detection
    if (!issues.some((i) => i.includes("color cast"))) {
      if (colorTemp > 35) {
        issues.push(`warm color temperature (+${colorTemp.toFixed(0)})`);
        hints.push(
          "The image has a warm color temperature (indoor/tungsten lighting). Cool the white balance slightly for more accurate colors.",
        );
      } else if (colorTemp < -30) {
        issues.push(`cool color temperature (${colorTemp.toFixed(0)})`);
        hints.push(
          "The image has a cool/blue color temperature (shade or overcast lighting). Warm the white balance slightly for more natural tones.",
        );
      }
    }

    // -------------------------------------------------------------------
    // 9. TONAL COMPRESSION — are the midtones bunched?
    //    If stdev is low but the total range is wide, midtones are compressed.
    // -------------------------------------------------------------------
    const midtoneCompression = dynamicRange > 180 && contrast < 40;
    if (midtoneCompression && !issues.some((i) => i.includes("contrast"))) {
      issues.push("compressed midtones");
      hints.push(
        "The image has full range but the midtones are compressed together. Apply a gentle S-curve to separate midtone values and add three-dimensionality.",
      );
    }

    // =====================================================================
    // Pass 2: Spatial analysis (sharpness, noise, vignetting)
    // Downsample to max 512px for speed — these are relative measures.
    // =====================================================================
    try {
      const meta = await sharp(buf).metadata();
      const w = meta.width || 1024;
      const h = meta.height || 1024;
      const analysisSize = Math.min(512, Math.min(w, h));

      // 10. SHARPNESS — Laplacian variance
      //     Convert to grayscale → Laplacian convolution → variance of result
      const grayBuf = await sharp(buf)
        .resize(analysisSize, analysisSize, { fit: "inside" })
        .grayscale()
        .raw()
        .toBuffer();

      const grayW =
        (
          await sharp(buf)
            .resize(analysisSize, analysisSize, { fit: "inside" })
            .grayscale()
            .metadata()
        ).width || analysisSize;
      const grayH = Math.floor(grayBuf.length / grayW);

      // Simple Laplacian: for each pixel, L = |4*center - top - bottom - left - right|
      let lapSum = 0;
      let lapSqSum = 0;
      let lapCount = 0;

      for (let y = 1; y < grayH - 1; y++) {
        for (let x = 1; x < grayW - 1; x++) {
          const idx = y * grayW + x;
          const lap =
            4 * grayBuf[idx] -
            grayBuf[(y - 1) * grayW + x] -
            grayBuf[(y + 1) * grayW + x] -
            grayBuf[y * grayW + (x - 1)] -
            grayBuf[y * grayW + (x + 1)];
          lapSum += Math.abs(lap);
          lapSqSum += lap * lap;
          lapCount++;
        }
      }

      const laplacianMean = lapCount > 0 ? lapSum / lapCount : 0;
      const laplacianVar =
        lapCount > 0 ? lapSqSum / lapCount - (lapSum / lapCount) ** 2 : 0;
      metrics.sharpness = Math.round(laplacianVar);
      metrics.edgeEnergy = Math.round(laplacianMean * 10) / 10;

      if (laplacianVar < 80) {
        issues.push(`very soft/blurry (sharpness=${laplacianVar.toFixed(0)})`);
        hints.push(
          "The image is noticeably soft or blurry. Apply subtle sharpening — increase edge definition and micro-contrast without introducing halos or artifacts.",
        );
      } else if (laplacianVar < 200) {
        issues.push(`slightly soft (sharpness=${laplacianVar.toFixed(0)})`);
        hints.push(
          "The image is slightly soft. Apply gentle sharpening to improve fine detail and edge clarity.",
        );
      }

      // 11. NOISE ESTIMATION — ratio of high-frequency energy to overall variance
      //     High laplacianMean relative to image stdev suggests noise.
      const grayStats = await sharp(buf)
        .resize(analysisSize, analysisSize, { fit: "inside" })
        .grayscale()
        .stats();
      const grayStdev = grayStats.channels[0].stdev;
      const noiseRatio = grayStdev > 0 ? laplacianMean / grayStdev : 0;
      metrics.noiseRatio = Math.round(noiseRatio * 100) / 100;

      if (noiseRatio > 1.8 && laplacianMean > 15) {
        issues.push(`noisy (ratio=${noiseRatio.toFixed(2)})`);
        hints.push(
          "The image shows visible noise/grain (likely high-ISO). Apply gentle noise reduction while preserving edge detail and texture.",
        );
      } else if (noiseRatio > 1.4 && laplacianMean > 12) {
        issues.push(`slight noise (ratio=${noiseRatio.toFixed(2)})`);
        hints.push(
          "The image has slight noise in the shadows. Apply subtle luminance noise reduction in darker areas.",
        );
      }

      // 12. VIGNETTING — compare edge brightness to center brightness
      //     Sample center region vs border regions of the grayscale image.
      const cx = Math.floor(grayW / 2);
      const cy = Math.floor(grayH / 2);
      const sampleRadius = Math.floor(Math.min(grayW, grayH) * 0.15);
      const borderWidth = Math.floor(Math.min(grayW, grayH) * 0.12);

      let centerSum = 0;
      let centerCount = 0;
      let edgeSum = 0;
      let edgeCount = 0;

      for (let y = 0; y < grayH; y++) {
        for (let x = 0; x < grayW; x++) {
          const val = grayBuf[y * grayW + x];
          const dx = x - cx;
          const dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < sampleRadius) {
            centerSum += val;
            centerCount++;
          } else if (
            x < borderWidth ||
            x >= grayW - borderWidth ||
            y < borderWidth ||
            y >= grayH - borderWidth
          ) {
            edgeSum += val;
            edgeCount++;
          }
        }
      }

      if (centerCount > 0 && edgeCount > 0) {
        const centerBrightness = centerSum / centerCount;
        const edgeBrightness = edgeSum / edgeCount;
        const vignetteDiff = centerBrightness - edgeBrightness;
        const vignetteRatio =
          centerBrightness > 0 ? vignetteDiff / centerBrightness : 0;
        metrics.vignetteRatio = Math.round(vignetteRatio * 100);

        if (vignetteRatio > 0.25) {
          issues.push(
            `strong vignetting (${(vignetteRatio * 100).toFixed(0)}%)`,
          );
          hints.push(
            "The image has noticeable vignetting (dark edges/corners). Lift the edge brightness slightly to even out the exposure across the frame.",
          );
        } else if (vignetteRatio > 0.15) {
          issues.push(
            `slight vignetting (${(vignetteRatio * 100).toFixed(0)}%)`,
          );
          hints.push(
            "The image has slight vignetting in the corners. Gently brighten the edges for more even illumination.",
          );
        }
      }
    } catch (spatialErr) {
      // Spatial analysis is best-effort — don't block on failure
      console.warn(
        "[image-analysis] Spatial analysis failed (non-blocking):",
        spatialErr,
      );
    }

    // =====================================================================
    // Summary
    // =====================================================================
    const summary =
      issues.length > 0
        ? `Image issues (${issues.length}): ${issues.join(", ")}`
        : "Image quality OK — no corrections needed";

    return { hints, summary, metrics };
  } catch (err) {
    console.warn("[image-analysis] Sharp analysis failed:", err);
    return {
      hints: [],
      summary: "Analysis skipped (sharp error)",
      metrics: {},
    };
  }
}

// =========================================================================
// Deterministic sharp corrections
// Applies programmatic fixes based on metrics — preserves resolution & quality.
// Returns a corrected PNG buffer (lossless).
// =========================================================================

export interface CorrectionResult {
  /** Corrected image buffer (PNG, same resolution) */
  buffer: Buffer;
  /** Human-readable list of corrections applied */
  applied: string[];
  /** The metrics from analysis that drove the corrections */
  metrics: Record<string, number>;
}

/**
 * Analyze and then apply deterministic corrections using sharp.
 * - Does NOT change resolution or add compression artifacts.
 * - All adjustments are conservative to avoid overcorrection.
 * - Returns the original buffer unchanged if no corrections needed.
 */
export async function applyCorrections(buf: Buffer): Promise<CorrectionResult> {
  const analysis = await analyzeImageQuality(buf);
  const { metrics } = analysis;
  const applied: string[] = [];

  // If nothing detected, return the original buffer as-is
  if (analysis.hints.length === 0) {
    return { buffer: buf, applied: [], metrics };
  }

  let pipeline = sharp(buf);

  // --- Exposure / Brightness correction via linear (gain + offset) ---
  // linear(a, b) → output = input * a + b
  const brightness = metrics.brightness ?? 128;
  let gain = 1.0;
  let offset = 0;

  if (brightness < 50) {
    // Very dark → substantial lift
    gain = 1.35;
    offset = 15;
    applied.push(
      `Exposure lift: gain=${gain}, offset=+${offset} (very dark, brightness=${brightness})`,
    );
  } else if (brightness < 80) {
    gain = 1.15;
    offset = 8;
    applied.push(
      `Exposure lift: gain=${gain}, offset=+${offset} (underexposed, brightness=${brightness})`,
    );
  } else if (brightness > 215) {
    gain = 0.8;
    offset = -10;
    applied.push(
      `Exposure pull: gain=${gain}, offset=${offset} (overexposed, brightness=${brightness})`,
    );
  } else if (brightness > 185) {
    gain = 0.92;
    offset = -5;
    applied.push(
      `Exposure pull: gain=${gain}, offset=${offset} (slightly bright, brightness=${brightness})`,
    );
  }

  // --- Contrast correction via linear ---
  const contrast = metrics.contrast ?? 50;
  if (contrast < 20) {
    // Very flat → stronger S-curve approximation via gain
    gain *= 1.3;
    offset -= 15;
    applied.push(`Contrast boost: +30% gain (very flat, stdev=${contrast})`);
  } else if (contrast < 30) {
    gain *= 1.15;
    offset -= 8;
    applied.push(`Contrast boost: +15% gain (low contrast, stdev=${contrast})`);
  } else if (contrast < 38) {
    gain *= 1.08;
    offset -= 4;
    applied.push(`Contrast boost: +8% gain (slightly flat, stdev=${contrast})`);
  }

  // Apply linear if any exposure/contrast correction was made
  if (gain !== 1.0 || offset !== 0) {
    pipeline = pipeline.linear(gain, offset);
  }

  // --- Saturation correction via modulate ---
  const sat = metrics.saturation ?? 30;
  let saturationMul = 1.0;
  if (sat < 10 && sat >= 0) {
    saturationMul = 1.5;
    applied.push(`Saturation boost: ×1.5 (severely desaturated, sat=${sat}%)`);
  } else if (sat < 16) {
    saturationMul = 1.25;
    applied.push(`Saturation boost: ×1.25 (low saturation, sat=${sat}%)`);
  } else if (sat > 65) {
    saturationMul = 0.85;
    applied.push(`Saturation reduce: ×0.85 (oversaturated, sat=${sat}%)`);
  }

  // --- Color temperature correction via modulate hue shift ---
  // We approximate warming/cooling by adjusting hue slightly
  // (sharp modulate doesn't have a tint param, so we combine saturation here)
  let brightnessMul = 1.0; // modulate brightness multiplier (separate from linear)
  if (saturationMul !== 1.0 || brightnessMul !== 1.0) {
    pipeline = pipeline.modulate({
      saturation: saturationMul,
      brightness: brightnessMul,
    });
  }

  // --- Color cast correction via recomb (per-channel scaling) ---
  // recomb() applies a 3×3 matrix to RGB channels — preserves colors
  // unlike tint() which converts to greyscale first.
  const rDev = metrics.rDeviation ?? 0;
  const gDev = metrics.gDeviation ?? 0;
  const bDev = metrics.bDeviation ?? 0;

  if (Math.abs(rDev) > 12 || Math.abs(gDev) > 12 || Math.abs(bDev) > 12) {
    // Scale each channel to counter the cast.
    // rDev=29 means red is 29% above average → scale red DOWN by ~0.87
    // bDev=-23 means blue is 23% below average → scale blue UP by ~1.12
    // We use a gentle strength factor to avoid overcorrection.
    const strength = 0.5; // apply only 50% of the theoretical correction
    const rScale = 1.0 / (1.0 + (rDev / 100) * strength);
    const gScale = 1.0 / (1.0 + (gDev / 100) * strength);
    const bScale = 1.0 / (1.0 + (bDev / 100) * strength);

    // Diagonal recomb matrix — scales channels independently
    pipeline = pipeline.recomb([
      [rScale, 0, 0],
      [0, gScale, 0],
      [0, 0, bScale],
    ]);
    applied.push(
      `Color cast correction: recomb(r×${rScale.toFixed(3)}, g×${gScale.toFixed(3)}, b×${bScale.toFixed(3)}) (rDev=${rDev}%, gDev=${gDev}%, bDev=${bDev}%)`,
    );
  }

  // --- Dynamic range expansion via normalise ---
  const dynamicRange = metrics.dynamicRange ?? 255;
  if (dynamicRange < 120) {
    pipeline = pipeline.normalise();
    applied.push(`Dynamic range expansion: normalise (range=${dynamicRange})`);
  }

  // --- Sharpening ---
  const sharpness = metrics.sharpness ?? 500;
  if (sharpness < 80) {
    pipeline = pipeline.sharpen({ sigma: 1.2, m1: 1.0, m2: 0.5 });
    applied.push(`Sharpening: sigma=1.2 (very soft, sharpness=${sharpness})`);
  } else if (sharpness < 200) {
    pipeline = pipeline.sharpen({ sigma: 0.8, m1: 0.8, m2: 0.3 });
    applied.push(
      `Sharpening: sigma=0.8 (slightly soft, sharpness=${sharpness})`,
    );
  }

  // --- Noise reduction via median filter ---
  const noiseRatio = metrics.noiseRatio ?? 0;
  if (noiseRatio > 1.8) {
    pipeline = pipeline.median(3);
    applied.push(`Noise reduction: median(3) (noisy, ratio=${noiseRatio})`);
  } else if (noiseRatio > 1.4) {
    pipeline = pipeline.median(2);
    applied.push(
      `Noise reduction: median(2) (slight noise, ratio=${noiseRatio})`,
    );
  }

  // If nothing was actually applied, return original
  if (applied.length === 0) {
    return { buffer: buf, applied: [], metrics };
  }

  // Output as PNG to preserve quality — no resolution change
  const corrected = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  return { buffer: corrected, applied, metrics };
}
