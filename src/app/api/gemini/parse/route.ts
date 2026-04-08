import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import type { EditCategory, AiPolicy } from "@/types";
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
  /** AI policy from Reddit flair */
  aiPolicy?: AiPolicy;
}

type FacePreservation = "strict" | "light" | "none";

interface PromptEngineResponse {
  prompt: string;
  model: string;
  edit_type: string;
  edit_category: EditCategory;
  has_face_edit: boolean;
  face_preservation: FacePreservation;
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

const SYSTEM_PROMPT = `You analyze photo editing requests and return a short prompt + classification.

Look at the image(s) and the user's request. Return JSON:

{
  "edit_category": "<category>",
  "has_face_edit": true/false,
  "face_preservation": "strict" | "light" | "none",
  "edit_type": "people|background|object|text_removal|enhancement|composite",
  "prompt": "<your editing prompt>",
  "nsfw_flag": false
}

CATEGORIES:
- "remove_object" — Remove person, object, text, watermark, stain, etc.
- "remove_background" — Remove or replace background
- "enhance_beautify" — Sharpen, unblur, lighting, skin smoothing
- "restore_old_photo" — Repair old/damaged photos, colorize B&W
- "face_swap" — Swap faces between people
- "add_object" — Add object, person, element, text, tattoo, etc.
- "color_correction" — Fix colors, white balance, change object color
- "scene_change" — Change environment, season, weather
- "creative_fun" — Meme, artistic, humorous edits
- "text_edit" — Add/edit/remove text in image
- "composite_multi" — Combine parts of multiple images
- "body_modification" — Reshape body, open/close eyes, change pose
- "professional_headshot" — Professional portrait, headshot

FACE FLAGS:
- has_face_edit: true if the edit touches a face directly (retouching, shadow removal on face, face swap, glasses removal). false if removing a whole person, background change, etc.
- face_preservation: "strict" (default when people are present), "light" (creative edits on faces), "none" (no people)

PROMPT RULES:
- Maximum 3-4 sentences. Be concise and direct.
- Identify which person/object to change by position and visual description (clothing, hair color, etc.)
- State what to change and the desired result.
- If people are in the image, add: "Keep all facial features untouched." (unless the edit is specifically on a face)
- If multiple images: describe what to take from the reference image and say "Use the second provided image as reference."
- NEVER add "ultra HD", "8K", "hyperrealistic", "high quality"
- NEVER invent edits the user didn't ask for
- Use visual descriptions, NOT names for people
- Content filter: vape/smoking → "small handheld object", gun/weapon → "object", alcohol → "beverage", blood → "stain", nude → set nsfw_flag: true

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
    const aiPolicy = reqBody.aiPolicy || "unknown";

    const imageContext = hasMultipleImages
      ? "\n\nIMPORTANT — MULTIPLE IMAGES: The FIRST image is the main image to edit. The other image(s) are reference images. Follow the REFERENCE IMAGE RULES in the system prompt — describe everything from the reference in rich visual detail AND include 'use the second provided image as visual reference' so models that can see multiple images will also use the actual reference."
      : "";

    // AI policy context — affects prompt strictness
    const aiPolicyContext =
      aiPolicy === "no_ai"
        ? "\n\nIMPORTANT — NO AI POLICY: The user has tagged this as 'No AI'. Your prompt must describe the ABSOLUTE MINIMUM change. The result must look completely natural and unedited. Do NOT add any extra improvements, enhancements, or changes. Only describe exactly what was requested, nothing more. The edit should be invisible."
        : aiPolicy === "ai_ok"
          ? "\n\nNote: The user allows AI-generated content, but still keep edits minimal and focused on what was requested. Do not add unnecessary improvements."
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
              text: `${SYSTEM_PROMPT}${imageContext}${aiPolicyContext}\n\nUser request: "${userText}"`,
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
      face_preservation?: FacePreservation;
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
    const VALID_FACE_PRES: FacePreservation[] = ["strict", "light", "none"];
    const facePreservation: FacePreservation = VALID_FACE_PRES.includes(
      parsed.face_preservation as FacePreservation,
    )
      ? (parsed.face_preservation as FacePreservation)
      : "strict"; // default to strict — safer to over-preserve than destroy faces

    // Use main image (first) dimensions for resolution/aspect ratio
    const mainImage = allImages[0];

    const result: PromptEngineResponse = {
      prompt: parsed.prompt,
      model: getModelId(category),
      edit_type: parsed.edit_type,
      edit_category: category,
      has_face_edit: hasFaceEdit,
      face_preservation: facePreservation,
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
        face_preservation: "strict" as FacePreservation,
        resolution: "1K",
        aspect_ratio: "1:1",
        nsfw_flag: false,
      } satisfies Omit<PromptEngineResponse, "token_usage">,
      { status: 500 },
    );
  }
}
