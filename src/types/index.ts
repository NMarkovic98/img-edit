// Reddit API Types
export interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  url: string;
  author: string;
  created_utc: number;
  thumbnail?: string;
  num_comments?: number;
  score?: number;
  permalink?: string;
}

// ---------------------------------------------------------------------------
// AI Policy — extracted from Reddit post flair
// ---------------------------------------------------------------------------
export type AiPolicy = "ai_ok" | "no_ai" | "unknown";

// ---------------------------------------------------------------------------
// Edit Categories — drives automatic model selection
// ---------------------------------------------------------------------------
export type EditCategory =
  | "remove_object" // Remove person/object from image
  | "remove_background" // Remove or replace background
  | "enhance_beautify" // Improve quality, lighting, skin, headshot
  | "restore_old_photo" // Fix old/damaged/faded photographs
  | "face_swap" // Swap faces between people
  | "add_object" // Add object/element to scene
  | "color_correction" // Fix colors, white balance, skin tone
  | "scene_change" // Change environment/season/background context
  | "creative_fun" // Funny/creative edits, memes
  | "text_edit" // Edit/add/remove text on image
  | "composite_multi" // Combine multiple photos into one
  | "body_modification" // Change pose, height, proportions
  | "professional_headshot"; // Make professional portrait/headshot

// Face-safe models that preserve realistic faces
export const FACE_SAFE_MODELS = [
  "fal-ai/flux-pro/kontext",
  "fal-ai/flux-pro/kontext/max",
  "fal-ai/flux-2-pro/edit",
  "fal-ai/flux-2-max/edit",
  "fal-ai/nano-banana-pro/edit",
] as const;

// Model routing table: category → [primary, ...fallbacks]
export const CATEGORY_MODEL_MAP: Record<EditCategory, string[]> = {
  remove_object: ["fal-ai/flux-pro/kontext", "fal-ai/flux-2-pro/edit"],
  remove_background: ["bria-bg-remove", "fal-ai/flux-pro/kontext"], // special: bria pipeline
  enhance_beautify: ["fal-ai/flux-2-pro/edit", "fal-ai/nano-banana-pro/edit"],
  restore_old_photo: [
    "fal-ai/nano-banana-2/edit",
    "fal-ai/nano-banana-pro/edit",
  ],
  face_swap: ["fal-ai/flux-pro/kontext", "fal-ai/nano-banana-2/edit"],
  add_object: ["fal-ai/flux-2-pro/edit", "fal-ai/nano-banana-2/edit"],
  color_correction: ["fal-ai/flux-pro/kontext", "fal-ai/flux-2-pro/edit"],
  scene_change: [
    "fal-ai/bytedance/seedream/v5/lite/edit",
    "fal-ai/flux-2-pro/edit",
  ],
  creative_fun: ["fal-ai/nano-banana-2/edit", "fal-ai/flux-pro/kontext"],
  text_edit: ["fal-ai/flux-pro/kontext/max", "fal-ai/flux-pro/kontext"],
  composite_multi: ["fal-ai/nano-banana-2/edit", "fal-ai/flux-2-pro/edit"],
  body_modification: ["fal-ai/flux-pro/kontext", "fal-ai/nano-banana-pro/edit"],
  professional_headshot: [
    "fal-ai/flux-2-pro/edit",
    "fal-ai/flux-pro/kontext/max",
  ],
};

// Human-readable category labels
export const CATEGORY_LABELS: Record<EditCategory, string> = {
  remove_object: "🗑️ Remove Object/Person",
  remove_background: "🖼️ Remove Background",
  enhance_beautify: "✨ Enhance / Beautify",
  restore_old_photo: "🔧 Restore Old Photo",
  face_swap: "🔄 Face Swap",
  add_object: "➕ Add Object",
  color_correction: "🎨 Color Correction",
  scene_change: "🌅 Scene Change",
  creative_fun: "🎭 Creative / Fun",
  text_edit: "✏️ Text Edit",
  composite_multi: "🧩 Combine Photos",
  body_modification: "🦴 Body Modification",
  professional_headshot: "📸 Professional Headshot",
};

// Edit Form Types (Gemini Parse Output)
export interface EditForm {
  task_type:
    | "object_removal"
    | "object_addition"
    | "color_enhancement"
    | "background_removal"
    | "text_addition"
    | "style_transfer"
    | "other";
  instructions: string;
  objects_to_remove: string[];
  objects_to_add: string[];
  style: "realistic" | "artistic" | "vintage" | "modern" | "other";
  mask_needed: boolean;
  additional_instructions?: string;
}

// Processing Request Types
export interface EditRequest {
  id: string;
  post: RedditPost;
  status: "pending" | "processing" | "completed" | "failed";
  editForm?: EditForm;
  editedImageUrl?: string;
  error?: string;
  processingTime?: number;
  timestamp: number;
}

// History Item Types
export interface HistoryItem {
  id: string;
  postId: string;
  postTitle: string;
  requestText: string;
  status: "completed" | "failed";
  originalImageUrl: string;
  editedImageUrl?: string;
  editForm: EditForm;
  timestamp: number;
  processingTime?: number;
}

// API Response Types
export interface RedditApiResponse {
  posts: RedditPost[];
  total: number;
  timestamp: string;
  note?: string;
}

export interface ParseApiResponse extends EditForm {}

export interface EditApiResponse {
  success: boolean;
  imageUrl?: string;
  error?: string;
  processingTime: number;
}

// Component Props Types
export interface QueueViewProps {
  onProcessEdit?: (post: RedditPost) => Promise<void>;
  refreshTrigger?: number;
}

export interface EditorViewProps {
  currentRequest?: EditRequest;
  onDownload?: (url: string, filename: string) => void;
}

export interface HistoryViewProps {
  items?: HistoryItem[];
  onViewDetails?: (item: HistoryItem) => void;
  onDownload?: (url: string, filename: string) => void;
}

// Dashboard State Types
export interface DashboardState {
  activeTab: "queue" | "editor" | "history";
  posts: RedditPost[];
  editRequests: EditRequest[];
  history: HistoryItem[];
  selectedResult?: EditRequest;
  loading: boolean;
}

// Error Types
export interface ApiError {
  message: string;
  code?: string;
  status?: number;
}

// Utility Types
export type ProcessingStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";
export type TaskType = EditForm["task_type"];
export type StyleType = EditForm["style"];

// Theme Types
export type Theme = "dark" | "light";

export interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}
