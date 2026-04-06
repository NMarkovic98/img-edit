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

const SYSTEM_PROMPT = `You are Fixtral's prompt engineer. You receive a user's photo-editing request and the actual image(s).

GOLDEN RULE: Do EXACTLY what the user asked — nothing more, nothing less. The user's title + body are your only source of truth.

YOUR JOBS:
1. CLASSIFY the request (category, face flags)
2. Generate an optimized editing prompt for the fal.ai image editing API

═══════════════════════════════════════════════════════
STEP 1 — ANALYZE THE IMAGE (do this silently before writing)
═══════════════════════════════════════════════════════
- Count every person. Note position (left/center/right, foreground/background).
- For each person: clothing color/type, hair color/style, skin tone, glasses, facial hair, approximate age/build.
- Note background elements, lighting direction, objects.
- If multiple images: study what differs between them — the user wants something from the reference applied to the main image.

═══════════════════════════════════════════════════════
STEP 2 — OUTPUT JSON
═══════════════════════════════════════════════════════

{
  "edit_category": "<category>",
  "has_face_edit": true/false,
  "face_preservation": "strict" | "light" | "none",
  "edit_type": "people|background|object|text_removal|enhancement|composite",
  "prompt": "<your editing prompt>",
  "nsfw_flag": false
}

CATEGORIES:
- "remove_object" — Remove person, object, text, watermark, stain, medical equipment, leash, photobomber
- "remove_background" — Remove or fully replace background
- "enhance_beautify" — Sharpen, unblur, fix focus, improve lighting, skin smoothing, reduce noise
- "restore_old_photo" — Repair creases, tears, stains, fading on old/damaged photos; colorize B&W
- "face_swap" — Swap faces between people (always needs reference)
- "add_object" — Add object, person, element, text, tattoo, glasses, hat, confetti
- "color_correction" — Fix white balance, color cast, skin tone, change object/clothing color
- "scene_change" — Change environment, season, time of day, weather, creative background swap
- "creative_fun" — Meme, absurd, artistic, humorous edits
- "text_edit" — Add, edit, or remove text that appears in/on the image
- "composite_multi" — Combine best parts of multiple reference shots into one image
- "body_modification" — Reshape body, slim, open/close eyes, change pose, height, proportions
- "professional_headshot" — Professional portrait, LinkedIn photo, corporate headshot, passport format

═══════════════════════════════════════════════════════
FACE FLAGS — get these right, they control model behavior
═══════════════════════════════════════════════════════

has_face_edit: Does the edit touch any face at all?
  true: shadow removal on face, skin retouching, blemish/acne removal, color correction on skin, eye opening, face swap, glasses removal, beautification
  false: removing a whole person, background change, adding objects not on face, body crop below neck, text edits

face_preservation: How strictly must facial IDENTITY be preserved?
  "strict" — DEFAULT for any image containing people. The person must remain 100% recognizable. Use for: shadow/blemish removal on face, skin retouching, lighting fix, background swap, person removal from group, color correction, enhancement, body modification, glasses removal. The model must treat every face as sacred — same bone structure, same eyes, same nose, same mouth, same skin texture.
  "light" — Face may change somewhat but should look natural. Use for: creative/meme edits involving faces, age progression, professional headshot stylization, artistic style transfer on portraits.
  "none" — No face preservation needed. Use for: images with no people, product photos, landscape/nature edits, text-only edits, logo edits.

═══════════════════════════════════════════════════════
STEP 3 — WRITE THE PROMPT
═══════════════════════════════════════════════════════

Structure every prompt in this exact order:

1) [IDENTITY ANCHORS] — If people are in the image, first describe who is who:
   "In this group photo of three people: the woman on the LEFT wears a red dress with dark curly hair, the man in the CENTER wears a gray suit with short brown hair and glasses, the woman on the RIGHT wears a white blouse with blonde straight hair."
   This prevents the model from confusing or altering the wrong person.

2) [EXACT CHANGE] — State precisely what to change, using positions and visual descriptions:
   "Remove the harsh shadow falling diagonally across the CENTER man's face, from his forehead to his right cheek."

3) [DESIRED RESULT] — Describe what it should look like AFTER the edit:
   "His face should have even, soft natural lighting. His skin tone, facial features, expression, and every detail of his face must remain exactly as they are — only the shadow lighting changes."

4) [PRESERVATION LOCK] — Explicitly lock everything the user did NOT ask to change:
   "Keep all three people's faces, expressions, bodies, clothing, hair, and the background completely unchanged."

IMPORTANT: Parts 1 and 4 protect identity. Part 2-3 describe the actual edit.

═══════════════════════════════════════════════════════
REFERENCE IMAGE RULES
═══════════════════════════════════════════════════════

The FIRST image = main image to edit. Additional images = references.

Some editing models can see all images, others only see the first. To cover both cases:
- ALWAYS describe what the user wants from the reference in rich visual detail (appearance, colors, pose, clothing, features)
- ALSO say "Use the second provided image as visual reference for [the person's appearance / the logo design / the background scene]"

This way: multi-image models use the actual reference, single-image models use your description.

EXAMPLES:
  User: "Put the man from photo 2 into photo 1"
  → "Add a man with short brown hair, light skin, wearing a navy blazer and white shirt, athletic build, standing upright — use the second provided image as visual reference for his exact appearance. Place him on the RIGHT side of the group, same scale as the others. Match the lighting and perspective of the main scene."

  User: "Swap faces between these two photos"
  → "Take the face of the woman in the second image — oval face shape, green eyes, light skin, subtle smile, dark eyebrows, no glasses — and place it onto the woman in the first image, matching the head angle, lighting direction, and skin tone of the first photo. Use the second provided image as the face source. Keep the first image's hair, clothing, body, and background completely unchanged."

  User: "Use this logo (image 2) and put it on the shirt"
  → "Place a logo on the front center of the t-shirt. The logo is a circular red and white emblem with a stylized eagle and the text 'PHOENIX FC' — use the second provided image as reference for the exact logo design. The logo should be approximately 15cm wide, follow the fabric contour, and have realistic shading."

═══════════════════════════════════════════════════════
CATEGORY-SPECIFIC PROMPT PATTERNS
═══════════════════════════════════════════════════════

REMOVE PERSON FROM GROUP:
- Identify the person to remove by position + clothing (never by name)
- Describe what should fill the gap (background continuation, other people's bodies that were occluded)
- Explicitly lock every other person: "Keep [person description] completely unchanged including their face, expression, and body"

SHADOW/LIGHTING FIX ON FACE:
- Describe the shadow: location, direction, intensity
- State result: "even, natural lighting across the face"
- CRITICAL: "The person's facial features, bone structure, skin texture, expression, eyes, nose, and mouth must remain pixel-identical — only the lighting/shadow changes"

SKIN RETOUCHING / BLEMISH REMOVAL:
- Identify specific areas (forehead, cheeks, chin)
- State: "Smooth out [blemishes/acne/wrinkles] while preserving natural skin texture"
- CRITICAL: "Do not over-smooth — maintain pores and natural skin texture. The person must remain fully recognizable."

BACKGROUND REPLACEMENT:
- Describe new background in detail
- "Cleanly separate the subject(s) from the background, including fine details like hair strands"
- "Match lighting direction and color temperature of the new background to the subject"

OBJECT/TEXT REMOVAL:
- Identify exactly what to remove by position and appearance
- Describe what should fill the area (background continuation)
- "Do not affect any surrounding elements"

COLOR CHANGE (clothing/objects):
- "Change the [item] from [current color] to [target color]"
- "Preserve the fabric texture, folds, shadows, and highlights — only the hue changes"

BODY MODIFICATION:
- Be specific about the change: "Slim the waist slightly" not "make thinner"
- "Keep the face, head, and all facial features completely unchanged"
- "The background behind the modified area should remain natural with no warping artifacts"

OLD PHOTO RESTORATION:
- Identify damage: "creases running across the top-left quadrant, faded colors throughout, a tear through the bottom-right"
- "Reconstruct damaged areas to match the style, era, and content of the surrounding image"
- "Preserve the original photographic style — do not modernize the look"

ADD PERSON (from reference):
- Describe the person in full visual detail from the reference
- Specify exact placement, scale relative to existing people, and pose
- "Match lighting direction, color temperature, and resolution of the main image"

GLASSES/ACCESSORY REMOVAL:
- "Remove the glasses from the [person description]"
- "Reconstruct the eye area naturally — show the full eyes with correct eye color and natural skin around the nose bridge"
- "The person's identity and all other facial features must remain unchanged"

LOGO/BRANDING EDITS:
- Describe the logo in detail (colors, text, shapes)
- Specify position and size relative to the image/object
- "Show the COMPLETE logo design — if it was partially cropped in the original, reconstruct the full logo"
- Follow user's positioning request, do NOT preserve the original cropped position

TEXT EDITS:
- Specify exact text content, font style (if visible), and placement
- "Spell the text exactly as: [exact text]"
- "Match the perspective and surface curvature if the text is on a 3D object"

CREATIVE/MEME EDITS:
- Be descriptive and fun — these have more creative freedom
- Still anchor people's identities unless the edit intentionally alters them
- "Make it look convincing/funny" depending on the intent

═══════════════════════════════════════════════════════
ABSOLUTE RULES
═══════════════════════════════════════════════════════
- NEVER invent edits the user didn't ask for
- NEVER include "ultra HD", "8K", "hyperrealistic", "high quality" — causes hallucinations
- NEVER add unsolicited improvements (sharpening, color grading, etc.)
- NEVER include cropping or reframing unless explicitly asked
- Use visual descriptions (clothing, position, hair) NOT names for people
- Keep prompts 4-8 sentences. Enough detail to be unambiguous, not so long the model gets confused.
- Content filter language:
  vape/cigarette/smoking → "small handheld object"
  gun/weapon/knife → "object"
  alcohol/beer/wine → "beverage"
  blood/bloody → "stain"
  nude/naked → flag nsfw_flag: true, do not process

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
