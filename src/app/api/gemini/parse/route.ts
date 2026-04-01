import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import type { EditCategory } from "@/types";
import { CATEGORY_MODEL_MAP, CATEGORY_LABELS } from "@/types";

interface ImageInput {
  base64: string;
  width: number;
  height: number;
}

interface ParseRequest {
  title: string;
  body?: string;
  /** Single image (backward compat) */
  imageBase64?: string;
  imageWidth?: number;
  imageHeight?: number;
  /** Multiple images — first is main, rest are references */
  images?: ImageInput[];
}

interface PromptEngineResponse {
  prompt: string;
  model: string;
  edit_type: string;
  edit_category: EditCategory;
  has_face_edit: boolean;
  resolution: string;
  aspect_ratio: string;
  nsfw_flag: boolean;
  token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function getResolutionTier(width: number, height: number): string {
  const longestSide = Math.max(width, height);
  if (longestSide <= 1024) return "1K";
  if (longestSide <= 2048) return "2K";
  return "4K";
}

function getAspectRatio(width: number, height: number): string {
  const ratio = width / height;
  const supported = [
    { name: "21:9", value: 21 / 9 },
    { name: "16:9", value: 16 / 9 },
    { name: "3:2", value: 3 / 2 },
    { name: "4:3", value: 4 / 3 },
    { name: "5:4", value: 5 / 4 },
    { name: "1:1", value: 1 },
    { name: "4:5", value: 4 / 5 },
    { name: "3:4", value: 3 / 4 },
    { name: "2:3", value: 2 / 3 },
    { name: "9:16", value: 9 / 16 },
  ];

  let closest = supported[0];
  let minDiff = Math.abs(ratio - supported[0].value);

  for (const ar of supported) {
    const diff = Math.abs(ratio - ar.value);
    if (diff < minDiff) {
      minDiff = diff;
      closest = ar;
    }
  }

  return closest.name;
}

function getModelId(category: EditCategory): string {
  const models = CATEGORY_MODEL_MAP[category];
  return models?.[0] ?? "fal-ai/flux-pro/kontext";
}

function detectMimeType(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

// Map legacy edit_type strings to new EditCategory
function mapLegacyEditType(editType: string): EditCategory {
  switch (editType) {
    case "people":
      return "remove_object";
    case "background":
      return "remove_background";
    case "object":
      return "remove_object";
    case "text_removal":
      return "text_edit";
    case "enhancement":
      return "enhance_beautify";
    case "composite":
      return "composite_multi";
    default:
      return "remove_object";
  }
}

const VALID_CATEGORIES: EditCategory[] = [
  "remove_object",
  "remove_background",
  "enhance_beautify",
  "restore_old_photo",
  "face_swap",
  "add_object",
  "color_correction",
  "scene_change",
  "creative_fun",
  "text_edit",
  "composite_multi",
  "body_modification",
  "professional_headshot",
];

const SYSTEM_PROMPT = `You are Fixtral's prompt engineer and request classifier. You receive a user's photo editing request and the actual image.

Your job is TWO things:
1. CLASSIFY the request into a category for automatic model selection
2. Generate an optimized editing prompt for the fal.ai image editing API

ANALYZE THE IMAGE FIRST:
- Identify all people (positions: left, center, right, foreground, background)
- Note their clothing, hair, distinguishing features
- Describe the background/scene
- Note lighting conditions and color palette

THEN generate your response as JSON:

{
  "edit_category": "one of the categories below",
  "has_face_edit": true/false,
  "edit_type": "people|background|object|text_removal|enhancement|composite",
  "prompt": "your detailed editing prompt here",
  "nsfw_flag": false
}

CATEGORIES — pick the BEST match:
- "remove_object" — Remove a person, object, or unwanted element from the image
- "remove_background" — Remove or completely replace the background
- "enhance_beautify" — Improve quality, lighting, skin smoothing, general beautification
- "restore_old_photo" — Fix old, damaged, faded, or low-quality old photographs
- "face_swap" — Swap faces between people in the image
- "add_object" — Add a new object, person, or element to the scene
- "color_correction" — Fix colors, white balance, skin tone, remove jaundice/redness
- "scene_change" — Change environment, season, time of day, weather
- "creative_fun" — Funny, creative, absurd, or meme-style edits
- "text_edit" — Edit, add, or remove text that appears on/in the image
- "composite_multi" — Combine multiple reference images into one composite
- "body_modification" — Change pose, height, proportions, stance, open/close eyes
- "professional_headshot" — Make a professional portrait, LinkedIn photo, corporate headshot

HAS_FACE_EDIT — set to true if the edit DIRECTLY modifies a human face:
- Changing skin color/tone: true
- Removing jaundice/redness from face: true
- Opening/closing eyes: true
- Face swap: true
- Smoothing skin / beautifying portrait: true
- Removing a person (not editing their face, removing them entirely): false
- Changing background behind a person: false
- Adding an object to someone's hand: false
- Creative edits that don't alter facial features: false

PROMPT STRUCTURE — always follow this 3-part format:

[WHAT TO CHANGE]: Be extremely specific. Reference exact positions, colors, and objects.
  - "Remove the man on the LEFT wearing a dark blue zip-up sweatshirt"
  - "Remove the large red text 'FREAK MATCHED' from the center of the image"
  - "Fill in the temple areas of the man on the front left with dark brown hair"

[HOW IT SHOULD LOOK]: Describe what should replace the edited area.
  - "Fill the area with natural continuation of the tram tracks, platform, and nighttime street scene"
  - "Fill with the dark foggy atmosphere and rocky terrain visible behind the text"
  - "New hair should match his existing hair color, texture, and style"

[WHAT NOT TO CHANGE]: Explicitly lock everything else.
  - "Keep the man on the right in the green polo completely unchanged — preserve his face, expression, body position, and clothing"
  - "Do not modify the two characters, the stone bridge, or the overall lighting"
  - "Preserve all other facial features, skin texture, and the background"

CRITICAL RULES:
- NEVER include "ultra HD", "8K", "hyperrealistic", "high quality" — these cause hallucinations
- NEVER add improvements the user didn't ask for (sharpening, color correction, etc.)
- NEVER ask to generate, regenerate, or replace any human face
- NEVER include cropping, reframing, or composition changes
- When describing people, use visual descriptions (clothing, position, hair) NOT names
- Keep prompts 3-6 sentences. Not too short (vague), not too long (confusing)
- Use neutral language — avoid words that trigger content filters:
  Replace: vape/cigarette/smoking → "small handheld object"
  Replace: gun/weapon/knife → "object"
  Replace: alcohol/beer/wine → "beverage"
  Replace: blood/bloody → "stain"
  Replace: nude/naked → do not process, flag nsfw_flag: true

Return ONLY valid JSON. No markdown, no code fences.`;

export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const reqBody: ParseRequest = await request.json();
    const { title, body } = reqBody;

    if (!title) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    // Normalize images — support both single image and array
    let allImages: ImageInput[];
    if (reqBody.images && reqBody.images.length > 0) {
      allImages = reqBody.images;
    } else if (reqBody.imageBase64) {
      allImages = [
        {
          base64: reqBody.imageBase64,
          width: reqBody.imageWidth || 1024,
          height: reqBody.imageHeight || 1024,
        },
      ];
    } else {
      return NextResponse.json(
        { error: "At least one image is required" },
        { status: 400 },
      );
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

    const userText = `${title}${body ? `\n\n${body}` : ""}`;
    const hasMultipleImages = allImages.length > 1;

    const imageContext = hasMultipleImages
      ? "\n\nThe FIRST image is the main image to edit. The other image(s) are reference images provided by the user — use them to understand what the user wants but apply edits ONLY to the first image."
      : "";

    const imageParts = allImages.map((img) => ({
      inlineData: {
        mimeType: detectMimeType(img.base64),
        data: img.base64,
      },
    }));

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${SYSTEM_PROMPT}${imageContext}\n\nUser request: "${userText}"`,
            },
            ...imageParts,
          ],
        },
      ],
    });

    if (!response?.text) {
      throw new Error("All parse models failed");
    }

    const rawText = response.text ?? "";
    const cleanedText = rawText.replace(/```json|```/g, "").trim();

    // Extract token usage from response
    const usageMetadata = response.usageMetadata;
    const tokenUsage = usageMetadata
      ? {
          prompt_tokens: usageMetadata.promptTokenCount ?? 0,
          completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
          total_tokens: usageMetadata.totalTokenCount ?? 0,
        }
      : undefined;

    if (tokenUsage) {
      console.log(
        `[Parse] Token usage — prompt: ${tokenUsage.prompt_tokens}, completion: ${tokenUsage.completion_tokens}, total: ${tokenUsage.total_tokens}`,
      );
    }

    let parsed: {
      edit_type: string;
      edit_category?: string;
      has_face_edit?: boolean;
      prompt: string;
      nsfw_flag: boolean;
    };

    try {
      parsed = JSON.parse(cleanedText);
    } catch {
      console.warn(
        "[Parse] Failed to parse Gemini response, using fallback. Raw:",
        cleanedText,
      );
      parsed = {
        edit_type: "composite",
        edit_category: "remove_object",
        has_face_edit: false,
        prompt: userText,
        nsfw_flag: false,
      };
    }

    // Validate category — fallback to remove_object if invalid
    const category: EditCategory = VALID_CATEGORIES.includes(
      parsed.edit_category as EditCategory,
    )
      ? (parsed.edit_category as EditCategory)
      : mapLegacyEditType(parsed.edit_type);

    const hasFaceEdit = parsed.has_face_edit ?? false;

    // Use main image (first) dimensions for resolution/aspect ratio
    const mainImage = allImages[0];

    const result: PromptEngineResponse = {
      prompt: parsed.prompt,
      model: getModelId(category),
      edit_type: parsed.edit_type,
      edit_category: category,
      has_face_edit: hasFaceEdit,
      resolution: getResolutionTier(mainImage.width, mainImage.height),
      aspect_ratio: getAspectRatio(mainImage.width, mainImage.height),
      nsfw_flag: parsed.nsfw_flag,
      token_usage: tokenUsage,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error parsing request with Gemini:", error);

    // Try to extract title from request for fallback
    let fallbackPrompt = "Edit this image as requested";
    try {
      const body = await request.clone().json();
      if (body.title) fallbackPrompt = body.title;
    } catch {
      // ignore
    }

    return NextResponse.json(
      {
        prompt: fallbackPrompt,
        model: "fal-ai/flux-pro/kontext",
        edit_type: "composite",
        edit_category: "remove_object" as EditCategory,
        has_face_edit: false,
        resolution: "1K",
        aspect_ratio: "1:1",
        nsfw_flag: false,
      } satisfies Omit<PromptEngineResponse, "token_usage">,
      { status: 500 },
    );
  }
}
