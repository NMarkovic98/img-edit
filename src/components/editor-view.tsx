"use client";

import { useState, useEffect, useCallback } from "react";
import { authedFetch } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
// Using native textarea instead
import { Badge } from "@/components/ui/badge";
import {
  Download,
  Wand2,
  Loader2,
  Save,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Image as ImageIcon,
  AlertTriangle,
  ShieldCheck,
  Copy,
  ClipboardCheck,
} from "lucide-react";
import Image from "next/image";
import { useImageViewer } from "./image-viewer";

// Local Browser Save Utility
class LocalBrowserSave {
  private dbName = "FixtralHistory";
  private storeName = "editHistory";
  private db: IDBDatabase | null = null;

  async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        console.error("IndexedDB error:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log("IndexedDB initialized successfully");
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: "id" });
          store.createIndex("timestamp", "timestamp", { unique: false });
          console.log("IndexedDB object store created");
        }
      };
    });
  }

  async saveToIndexedDB(data: any): Promise<boolean> {
    try {
      if (!this.db) {
        await this.initDB();
      }

      if (!this.db) {
        throw new Error("Failed to initialize IndexedDB");
      }

      return new Promise((resolve) => {
        const transaction = this.db!.transaction([this.storeName], "readwrite");
        const store = transaction.objectStore(this.storeName);
        const request = store.put(data);

        request.onsuccess = () => {
          console.log("Successfully saved to IndexedDB");
          resolve(true);
        };

        request.onerror = () => {
          console.error("Failed to save to IndexedDB:", request.error);
          resolve(false);
        };
      });
    } catch (error) {
      console.error("IndexedDB save error:", error);
      return false;
    }
  }

  async loadFromIndexedDB(): Promise<any[]> {
    try {
      if (!this.db) {
        await this.initDB();
      }

      if (!this.db) {
        throw new Error("Failed to initialize IndexedDB");
      }

      return new Promise((resolve) => {
        const transaction = this.db!.transaction([this.storeName], "readonly");
        const store = transaction.objectStore(this.storeName);
        const index = store.index("timestamp");
        const request = index.openCursor(null, "prev"); // Most recent first

        const results: any[] = [];

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            console.log("Loaded", results.length, "items from IndexedDB");
            resolve(results);
          }
        };

        request.onerror = () => {
          console.error("Failed to load from IndexedDB:", request.error);
          resolve([]);
        };
      });
    } catch (error) {
      console.error("IndexedDB load error:", error);
      return [];
    }
  }

  async saveToLocalStorage(data: any): Promise<boolean> {
    try {
      const key = "fixtral_editHistory";
      const existingData = this.loadFromLocalStorage();
      const updatedData = [data, ...existingData.slice(0, 49)]; // Keep last 50 items

      localStorage.setItem(key, JSON.stringify(updatedData));
      console.log("Successfully saved to localStorage");
      return true;
    } catch (error) {
      console.error("localStorage save error:", error);
      return false;
    }
  }

  loadFromLocalStorage(): any[] {
    try {
      const key = "fixtral_editHistory";
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error("localStorage load error:", error);
      return [];
    }
  }

  async saveWithFallback(
    data: any,
  ): Promise<{ success: boolean; method: string; downloadUrl?: string }> {
    console.log("Starting comprehensive save process...");

    // Method 1: Try IndexedDB
    try {
      const indexedDBSuccess = await this.saveToIndexedDB(data);
      if (indexedDBSuccess) {
        return { success: true, method: "IndexedDB" };
      }
    } catch (error) {
      console.warn("IndexedDB failed, trying localStorage...", error);
    }

    // Method 2: Try localStorage
    try {
      const localStorageSuccess = await this.saveToLocalStorage(data);
      if (localStorageSuccess) {
        return { success: true, method: "localStorage" };
      }
    } catch (error) {
      console.warn("localStorage failed, creating download link...", error);
    }

    // Method 3: Create manual download link
    try {
      const downloadUrl = await this.createDownloadLink(data);
      if (downloadUrl) {
        return { success: true, method: "download", downloadUrl };
      }
    } catch (error) {
      console.error("All save methods failed:", error);
    }

    return { success: false, method: "failed" };
  }

  async createDownloadLink(data: any): Promise<string | null> {
    try {
      const imageUrl = data.editedImageUrl || data.editedContent;
      if (!imageUrl) {
        throw new Error("No image URL found");
      }

      // Create a download link for the image
      const link = document.createElement("a");
      link.href = imageUrl;
      link.download = `fixtral_edit_${Date.now()}.png`;
      link.style.display = "none";
      document.body.appendChild(link);

      console.log("Created manual download link for image");
      return imageUrl;
    } catch (error) {
      console.error("Failed to create download link:", error);
      return null;
    }
  }

  async loadAllHistory(): Promise<any[]> {
    console.log("Loading history from all sources...");

    // Try IndexedDB first
    try {
      const indexedDBData = await this.loadFromIndexedDB();
      if (indexedDBData.length > 0) {
        console.log("Loaded from IndexedDB:", indexedDBData.length, "items");
        return indexedDBData;
      }
    } catch (error) {
      console.warn("IndexedDB load failed:", error);
    }

    // Fallback to localStorage
    try {
      const localStorageData = this.loadFromLocalStorage();
      if (localStorageData.length > 0) {
        console.log(
          "Loaded from localStorage:",
          localStorageData.length,
          "items",
        );
        return localStorageData;
      }
    } catch (error) {
      console.warn("localStorage load failed:", error);
    }

    console.log("No history data found");
    return [];
  }

  clearAllData(): void {
    try {
      // Clear IndexedDB
      if (this.db) {
        const transaction = this.db.transaction([this.storeName], "readwrite");
        const store = transaction.objectStore(this.storeName);
        store.clear();
      }

      // Clear localStorage
      localStorage.removeItem("fixtral_editHistory");
      localStorage.removeItem("editHistory");

      console.log("All local data cleared");
    } catch (error) {
      console.error("Failed to clear data:", error);
    }
  }
}

// Global instance
const localBrowserSave = new LocalBrowserSave();

// Export for use in other components
export { localBrowserSave };

// ---------------------------------------------------------------------------
// Client-side watermark generator — Canvas only, no AI model
// ---------------------------------------------------------------------------
async function createWatermarkedBlob(imageUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;

      // Draw original image at full quality
      ctx.drawImage(img, 0, 0);

      // Watermark settings — scale text relative to image size
      const fontSize = Math.max(14, Math.floor(Math.min(canvas.width, canvas.height) * 0.025));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const text = "Fixtral — Preview";

      // Semi-transparent diagonal watermark across the image
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 6); // -30 degrees

      const spacing = fontSize * 4;
      for (let y = -canvas.height; y < canvas.height; y += spacing) {
        for (let x = -canvas.width; x < canvas.width; x += spacing) {
          ctx.strokeText(text, x, y);
          ctx.fillText(text, x, y);
        }
      }
      ctx.restore();

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas toBlob failed"));
        },
        "image/png",
        1.0,
      );
    };
    img.onerror = () => reject(new Error("Failed to load image for watermark"));
    img.src = imageUrl;
  });
}

interface RedditPost {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  allImages?: string[];
  isGallery?: boolean;
  imageCount?: number;
  postUrl: string;
  created_utc: number;
  created_date: string;
  author: string;
  score: number;
  num_comments: number;
  subreddit: string;
}

interface EditorItem {
  id: string;
  post: RedditPost;
  allImages: string[];
  analysis: string;
  modelOverride?: string | null;
  timestamp: string;
}

interface QualityCheck {
  original: {
    width: number;
    height: number;
    sharpness: number;
    detailEnergy: number;
    noiseEstimate: number;
    megapixels: number;
  };
  generated: {
    width: number;
    height: number;
    sharpness: number;
    detailEnergy: number;
    noiseEstimate: number;
    megapixels: number;
  };
  comparison: {
    ssim: number;
    sharpnessRatio: number;
    detailRatio: number;
    noiseRatio: number;
  };
  qualityLost: boolean;
  issues: string[];
  verdict: string;
}

interface EditResult {
  ok: boolean;
  postId: string;
  analysis: string;
  editedContent: string;
  method?: string;
  hasImageData?: boolean;
  generatedImages?: string[];
  qualityCheck?: QualityCheck | null;
  geminiOutputSize?: string;
  geminiAspectRatio?: string;
  originalDimensions?: { width: number; height: number };
  timestamp: string;
}

export function EditorView() {
  const [currentItem, setCurrentItem] = useState<EditorItem | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editResult, setEditResult] = useState<EditResult | null>(null);
  const [comparisonMode, setComparisonMode] = useState<
    "side-by-side" | "overlay"
  >("side-by-side");
  const [showOriginal, setShowOriginal] = useState(true);
  const [savedItems, setSavedItems] = useState<EditResult[]>([]);
  const [watermarkedUrl, setWatermarkedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { showImage } = useImageViewer();

  // Generate watermarked preview whenever a new editResult is ready
  const generateWatermark = useCallback(async (imgUrl: string) => {
    try {
      const blob = await createWatermarkedBlob(imgUrl);
      const url = URL.createObjectURL(blob);
      setWatermarkedUrl(url);
    } catch (err) {
      console.error("Watermark generation failed:", err);
      setWatermarkedUrl(null);
    }
  }, []);

  // Load pending item and user credits from localStorage when component mounts
  useEffect(() => {
    const loadPendingItem = () => {
      console.log("EditorView: Loading pending item...");
      const pendingItemStr = localStorage.getItem("pendingEditorItem");
      console.log(
        "EditorView: Pending item from localStorage:",
        pendingItemStr,
      );

      if (pendingItemStr) {
        try {
          const pendingItem = JSON.parse(pendingItemStr);
          console.log("EditorView: Parsed pending item:", pendingItem);

          setCurrentItem(pendingItem);
          setEditPrompt(pendingItem.analysis);

          console.log("EditorView: Set current item and edit prompt");

          // Clear the pending item from localStorage
          localStorage.removeItem("pendingEditorItem");
          console.log("EditorView: Cleared pending item from localStorage");
        } catch (error) {
          console.error("EditorView: Error loading pending item:", error);
        }
      } else {
        console.log("EditorView: No pending item found in localStorage");
      }
    };

    loadPendingItem();

    // Also listen for storage changes in case item is set from another tab
    const handleStorageChange = (e: StorageEvent) => {
      console.log("EditorView: Storage event received:", {
        key: e.key,
        newValue: e.newValue,
        oldValue: e.oldValue,
      });

      if (e.key === "pendingEditorItem" && e.newValue) {
        console.log(
          "EditorView: Pending item storage event detected, loading...",
        );
        loadPendingItem();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  // Generate edited image
  const generateEditedImage = async () => {
    if (!currentItem || !editPrompt.trim()) return;

    setIsEditing(true);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5min client timeout for 4K images

      const response = await authedFetch("/api/edit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          imageUrl: currentItem.post.imageUrl,
          changeSummary: editPrompt,
          allImages: currentItem.allImages || [currentItem.post.imageUrl],
          modelOverride: currentItem.modelOverride || null,
        }),
      });

      clearTimeout(timeoutId);

      const result = await response.json();
      console.log("Edit API response:", result);

      if (result.ok) {
        console.log("Edit successful, preparing result data...");

        // Validate result data
        const editedContent =
          result.edited || result.generatedImages?.[0] || "";
        const hasValidImage =
          editedContent &&
          (editedContent.startsWith("data:") ||
            editedContent.startsWith("http"));

        if (!hasValidImage) {
          console.warn("No valid image data in result:", {
            editedContent: editedContent?.substring(0, 50),
          });
        }

        const editResult: EditResult = {
          ok: true,
          postId: currentItem.post.id,
          analysis: editPrompt,
          editedContent: editedContent,
          method: result.method || "unknown",
          hasImageData: result.hasImageData || false,
          generatedImages: result.generatedImages || [],
          qualityCheck: result.qualityCheck || null,
          geminiOutputSize: result.geminiOutputSize || null,
          geminiAspectRatio: result.geminiAspectRatio || null,
          originalDimensions: result.originalDimensions || null,
          timestamp: result.timestamp || Date.now(),
        };

        console.log("Edit result prepared:", {
          postId: editResult.postId,
          hasEditedContent: !!editResult.editedContent,
          method: editResult.method,
          hasImageData: editResult.hasImageData,
        });

        setEditResult(editResult);

        // Generate watermarked preview
        const imgSrc = editResult.generatedImages?.[0] || editResult.editedContent;
        if (imgSrc) generateWatermark(imgSrc);
      } else {
        console.error("Edit failed:", result.error);
      }
    } catch (error: any) {
      if (error?.name === "AbortError") {
        console.error("Edit request timed out after 150s");
        alert(
          "The edit request timed out. The image may be too large or Gemini is busy. Please try again.",
        );
      } else {
        console.error("Error generating edited image:", error);
      }
    }
    setIsEditing(false);
  };

  // Save to history with comprehensive fallback system
  const saveToHistory = async (result: EditResult) => {
    console.log("Starting save to history process...");

    if (!result || !result.postId) {
      console.error("Invalid result data for saving:", result);
      alert("Invalid image data. Please try generating the image again.");
      return;
    }

    const historyItem = {
      id: `history_${Date.now()}`,
      postId: result.postId,
      postTitle: currentItem?.post?.title || "Generated Image",
      requestText:
        currentItem?.post?.description || result.analysis || "AI Generated",
      analysis: result.analysis,
      editPrompt: editPrompt,
      originalImageUrl: currentItem?.post?.imageUrl || "",
      editedImageUrl: result.generatedImages?.[0] || result.editedContent || "",
      editedContent: result.editedContent,
      generatedImages: result.generatedImages || [],
      postUrl: currentItem?.post?.postUrl || "",
      method: result.method || "fal_ai",
      status: "completed" as const,
      timestamp: Date.now(),
      savedAt: new Date().toISOString(),
      hasImageData: result.hasImageData || false,
    };

    let saveSuccess = false;
    let saveMethod = "failed";
    let downloadUrl: string | undefined;

    try {
      // Try local browser save
      const localSaveResult =
        await localBrowserSave.saveWithFallback(historyItem);

      if (localSaveResult.success) {
        saveSuccess = true;
        saveMethod = localSaveResult.method;
        downloadUrl = localSaveResult.downloadUrl;
      }

      if (saveSuccess) {
        setSavedItems((prev) => [result, ...prev]);
        setCurrentItem(null);
        setEditResult(null);
        setEditPrompt("");
        if (watermarkedUrl) { URL.revokeObjectURL(watermarkedUrl); setWatermarkedUrl(null); }

        localStorage.removeItem("pendingEditorItem");
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "pendingEditorItem",
            newValue: null,
            oldValue: null,
            storageArea: localStorage,
          }),
        );

        if (saveMethod === "download") {
          alert("Image generated! Download link created.");
        } else {
          alert(`Image saved via ${saveMethod}!`);
        }
      }
    } catch (error: any) {
      console.error("Error in save process:", error);

      // Last resort: Try manual download
      try {
        const imageUrl = result.generatedImages?.[0] || result.editedContent;
        if (
          imageUrl &&
          (imageUrl.startsWith("data:") || imageUrl.startsWith("http"))
        ) {
          const link = document.createElement("a");
          link.href = imageUrl;
          link.download = `fixtral_edit_${Date.now()}.png`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          alert("Manual download initiated! The image generation was successful.");
          return;
        }
      } catch (downloadError) {
        console.error("Even manual download failed:", downloadError);
      }

      alert("Unable to save. Image generation was successful, but all save methods failed.");
    }
  };

  const handleDownload = (imageUrl: string, filename: string) => {
    const link = document.createElement("a");
    link.href = imageUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6 px-2 sm:px-0">

      {/* Current Item Display */}
      {currentItem ? (
        <div className="space-y-6">
          {/* Post Info */}
          <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 shadow-xl">
            <CardHeader className="pb-4 px-3 sm:px-6">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-green-500 rounded-full flex-shrink-0">
                    <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
                  </div>
                  <div className="flex-1">
                    <CardTitle className="text-lg sm:text-xl font-bold">
                      Ready for Editing
                    </CardTitle>
                    <CardDescription className="text-muted-foreground text-sm">
                      Modify the prompt below and generate your edited image
                    </CardDescription>
                  </div>
                </div>
                <Badge
                  variant="secondary"
                  className="bg-primary/10 text-primary border-primary/20 font-semibold text-xs sm:text-sm w-fit"
                >
                  Step 2: AI Image Generation
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="px-3 sm:px-6">
              <div className="space-y-4">
                <div className="bg-card p-3 sm:p-6 rounded-xl border shadow-sm">
                  <h4 className="font-semibold mb-2 sm:mb-3 text-card-foreground text-sm sm:text-base">
                    {currentItem.post.title}
                  </h4>
                  <p className="text-xs sm:text-sm text-muted-foreground mb-3 sm:mb-4 leading-relaxed">
                    {currentItem.post.description}
                  </p>
                  <div className="flex items-center space-x-3 sm:space-x-6 text-xs text-muted-foreground">
                    <span className="flex items-center">
                      <span className="font-medium">By</span>{" "}
                      {currentItem.post.author}
                    </span>
                    <span>
                      {new Date(
                        currentItem.post.created_utc * 1000,
                      ).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                <div
                  className="relative aspect-video overflow-hidden rounded-xl border bg-card shadow-md cursor-pointer hover:shadow-lg transition-all duration-300 group"
                  onClick={() =>
                    showImage(
                      currentItem.post.imageUrl,
                      "Original Image",
                      currentItem.post.imageUrl,
                      currentItem.post.postUrl,
                    )
                  }
                >
                  <Image
                    src={currentItem.post.imageUrl}
                    alt="Original Reddit image"
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300 rounded-xl"></div>
                  <div className="absolute top-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-md font-medium">
                    Main Image
                  </div>
                </div>

                {/* Reference images */}
                {currentItem.allImages && currentItem.allImages.length > 1 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">
                      Reference Images ({currentItem.allImages.length - 1})
                    </h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {currentItem.allImages
                        .filter((img) => img !== currentItem.post.imageUrl)
                        .map((imgUrl, idx) => (
                          <div
                            key={idx}
                            className="relative aspect-square overflow-hidden rounded-lg border bg-card shadow-sm cursor-pointer hover:shadow-md transition-all duration-200 group"
                            onClick={() =>
                              showImage(
                                imgUrl,
                                `Reference Image ${idx + 1}`,
                                imgUrl,
                                currentItem.post.postUrl,
                              )
                            }
                          >
                            <Image
                              src={imgUrl}
                              alt={`Reference image ${idx + 1}`}
                              fill
                              className="object-cover group-hover:scale-105 transition-transform duration-200"
                            />
                            <div className="absolute top-1.5 left-1.5 bg-blue-600/80 text-white text-[10px] px-1.5 py-0.5 rounded font-medium">
                              Ref {idx + 1}
                            </div>
                          </div>
                        ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      All images will be sent to the AI — references guide the
                      edit.
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Edit Prompt */}
          <Card className="shadow-lg border-muted/20">
            <CardHeader className="bg-gradient-to-r from-muted/30 to-muted/10 rounded-t-lg">
              <CardTitle className="flex items-center space-x-3 text-lg">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <Wand2 className="h-5 w-5 text-primary" />
                </div>
                <span>Edit Prompt (Editable)</span>
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Modify this AI-generated prompt to customize your image editing
                requirements
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4 sm:pt-6 px-3 sm:px-6">
              <textarea
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                className="w-full p-3 sm:p-4 border border-input rounded-xl resize-none focus:ring-2 focus:ring-primary/50 focus:border-primary bg-background text-foreground transition-all duration-200 min-h-[100px] sm:min-h-[120px] text-[16px] sm:text-sm"
                rows={4}
                placeholder="Enter your edit instructions..."
              />
            </CardContent>
          </Card>

          {/* Generate Button */}
          <div className="flex justify-center px-2">
            <Button
              onClick={generateEditedImage}
              disabled={isEditing || !editPrompt.trim()}
              size="lg"
              className="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-semibold px-5 sm:px-8 py-3 sm:py-4 shadow-lg hover:shadow-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto text-sm sm:text-base"
            >
              {isEditing ? (
                <>
                  <Loader2 className="mr-3 h-5 w-5 animate-spin" />
                  Generating AI Image...
                </>
              ) : (
                <>
                  <Wand2 className="mr-3 h-5 w-5" />
                  Generate Edited Image
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <Card className="text-center py-12 sm:py-20 border-dashed border-muted-foreground/20 bg-gradient-to-br from-muted/20 to-muted/10">
          <CardContent className="space-y-4 sm:space-y-6">
            <div className="relative">
              <Wand2 className="mx-auto h-14 w-14 sm:h-20 sm:w-20 text-muted-foreground/50" />
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-muted-foreground/20 rounded-full animate-pulse"></div>
            </div>
            <div>
              <h3 className="text-xl font-semibold text-muted-foreground mb-2">
                No Items to Edit
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto leading-relaxed">
                Go to the Queue tab to analyze a Reddit post and send it here
                for editing.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edit Result Display */}
      {editResult && (
        <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 shadow-xl mobile-card">
          <CardHeader className="pb-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center space-x-3 flex-1">
                <div className="p-2 bg-green-500 rounded-full flex-shrink-0 touch-target">
                  <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-lg sm:text-xl font-bold mobile-responsive-heading">
                    AI Image Generated Successfully!
                  </CardTitle>
                  <CardDescription className="text-muted-foreground text-sm sm:text-base">
                    Your edited image is ready for download
                  </CardDescription>
                </div>
                <Badge
                  variant="secondary"
                  className="bg-primary/10 text-primary border-primary/20 font-semibold text-xs sm:text-sm flex-shrink-0"
                >
                  Step 3: Image Generated
                </Badge>
              </div>
              <div className="flex-shrink-0">
                <Button
                  onClick={() => saveToHistory(editResult)}
                  className="bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all duration-200 mobile-button w-full sm:w-auto"
                >
                  <Save className="mr-2 h-4 w-4" />
                  Save to History
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Quality Check Warning */}
            {editResult.qualityCheck && (
              <div
                className={`rounded-lg border p-4 ${
                  editResult.qualityCheck.qualityLost
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-green-500/50 bg-green-500/10"
                }`}
              >
                <div className="flex items-start gap-3">
                  {editResult.qualityCheck.qualityLost ? (
                    <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <ShieldCheck className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 space-y-2">
                    <p
                      className={`font-semibold text-sm ${
                        editResult.qualityCheck.qualityLost
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-green-600 dark:text-green-400"
                      }`}
                    >
                      {editResult.qualityCheck.verdict}
                    </p>
                    {editResult.qualityCheck.issues.length > 0 && (
                      <ul className="text-xs text-muted-foreground space-y-1">
                        {editResult.qualityCheck.issues.map((issue, i) => (
                          <li key={i}>- {issue}</li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
                      <span>
                        SSIM:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {(
                            editResult.qualityCheck.comparison.ssim * 100
                          ).toFixed(1)}
                          %
                        </span>
                      </span>
                      <span>
                        Sharpness:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {(
                            editResult.qualityCheck.comparison.sharpnessRatio *
                            100
                          ).toFixed(0)}
                          %
                        </span>
                      </span>
                      <span>
                        Detail:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {(
                            editResult.qualityCheck.comparison.detailRatio * 100
                          ).toFixed(0)}
                          %
                        </span>
                      </span>
                      <span>
                        Noise:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {(
                            editResult.qualityCheck.comparison.noiseRatio * 100
                          ).toFixed(0)}
                          %
                        </span>
                      </span>
                      <span>
                        Original:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {editResult.qualityCheck.original.width}x
                          {editResult.qualityCheck.original.height}
                        </span>
                      </span>
                      <span>
                        Generated:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {editResult.qualityCheck.generated.width}x
                          {editResult.qualityCheck.generated.height}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Resolution & API Config Info */}
            {(editResult.geminiOutputSize || editResult.originalDimensions) && (
              <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  {editResult.originalDimensions && (
                    <span>
                      Original:{" "}
                      <span className="font-mono font-medium text-foreground">
                        {editResult.originalDimensions.width}x
                        {editResult.originalDimensions.height}
                      </span>
                    </span>
                  )}
                  {editResult.geminiOutputSize && (
                    <span>
                      Requested Size:{" "}
                      <span className="font-mono font-medium text-foreground">
                        {editResult.geminiOutputSize}
                      </span>
                    </span>
                  )}
                  {editResult.geminiAspectRatio && (
                    <span>
                      Aspect Ratio:{" "}
                      <span className="font-mono font-medium text-foreground">
                        {editResult.geminiAspectRatio}
                      </span>
                    </span>
                  )}
                  {editResult.method && (
                    <span>
                      Model:{" "}
                      <span className="font-mono font-medium text-foreground">
                        {editResult.method}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Comparison Mode Toggle */}
            <div className="flex justify-center">
              <div className="flex bg-muted p-1 rounded-lg border shadow-sm">
                <Button
                  variant={
                    comparisonMode === "side-by-side" ? "default" : "ghost"
                  }
                  size="sm"
                  onClick={() => setComparisonMode("side-by-side")}
                  className={`rounded-md transition-all duration-200 font-medium ${
                    comparisonMode === "side-by-side"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  }`}
                >
                  Side by Side
                </Button>
                <Button
                  variant={comparisonMode === "overlay" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setComparisonMode("overlay")}
                  className={`rounded-md transition-all duration-200 font-medium ${
                    comparisonMode === "overlay"
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  }`}
                >
                  Overlay
                </Button>
              </div>
            </div>

            {comparisonMode === "side-by-side" ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Original Image */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground flex items-center space-x-2">
                      <ImageIcon className="h-4 w-4 text-primary" />
                      <span>Original Image</span>
                    </h3>
                    {currentItem && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          handleDownload(
                            currentItem.post.imageUrl,
                            "original.jpg",
                          )
                        }
                        className="border-muted-foreground/20 hover:bg-muted/50 transition-all duration-200"
                      >
                        <Download className="mr-2 h-4 w-4" />
                        Download
                      </Button>
                    )}
                  </div>
                  <div
                    className="relative aspect-video overflow-hidden rounded-lg border bg-card cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() =>
                      currentItem &&
                      showImage(
                        currentItem.post.imageUrl,
                        "Original Image",
                        currentItem.post.imageUrl,
                        currentItem.post.postUrl,
                      )
                    }
                  >
                    {currentItem && (
                      <Image
                        src={currentItem.post.imageUrl}
                        alt="Original image"
                        fill
                        className="object-cover"
                        unoptimized={currentItem.post.imageUrl?.startsWith(
                          "data:",
                        )}
                      />
                    )}
                  </div>
                </div>

                {/* Edited Image */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground flex items-center space-x-2">
                      <Wand2 className="h-4 w-4 text-primary" />
                      <span>AI-Edited Image</span>
                    </h3>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-muted-foreground/20 hover:bg-muted/50 transition-all duration-200"
                      onClick={() =>
                        handleDownload(
                          editResult.generatedImages?.[0] ||
                            editResult.editedContent,
                          "ai-edited.jpg",
                        )
                      }
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Download
                    </Button>
                  </div>

                  {editResult.generatedImages &&
                  editResult.generatedImages.length > 0 ? (
                    <div className="space-y-4">
                      {editResult.generatedImages.map((imageUrl, index) => (
                        <div
                          key={index}
                          className="relative aspect-video overflow-hidden rounded-lg border bg-card cursor-pointer hover:opacity-90 transition-opacity"
                          onClick={() =>
                            showImage(
                              imageUrl,
                              `AI Edited Image ${index + 1}`,
                              imageUrl,
                            )
                          }
                        >
                          <Image
                            src={imageUrl}
                            alt={`AI-generated edited image ${index + 1}`}
                            fill
                            className="object-cover"
                            unoptimized={imageUrl?.startsWith("data:")}
                          />
                        </div>
                      ))}
                      <div className="text-center">
                        <p className="text-xs text-green-600">
                          ✨ AI-generated images with SynthID watermarks
                        </p>
                      </div>
                    </div>
                  ) : editResult.editedContent.includes("data:image") ||
                    editResult.editedContent.startsWith("http") ? (
                    <div
                      className="relative aspect-video overflow-hidden rounded-lg border bg-card cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => {
                        const imgSrc = editResult.editedContent.includes("data:image")
                          ? editResult.editedContent.match(/data:image[^"']+/)?.[0] || ""
                          : editResult.editedContent;
                        showImage(imgSrc, "AI Edited Image", imgSrc);
                      }}
                    >
                      <Image
                        src={
                          editResult.editedContent.includes("data:image")
                            ? editResult.editedContent.match(/data:image[^"']+/)?.[0] || ""
                            : editResult.editedContent
                        }
                        alt="AI-generated edited image"
                        fill
                        className="object-cover"
                        unoptimized
                      />
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-sm text-muted-foreground">
                        Image generated successfully! Check the download link
                        above.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Overlay Mode */
              <div className="space-y-4">
                <div className="flex items-center justify-center space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowOriginal(!showOriginal)}
                  >
                    {showOriginal ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                  <span className="text-sm">
                    {showOriginal ? "Showing Original" : "Showing Edited"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      handleDownload(
                        showOriginal
                          ? currentItem?.post.imageUrl || ""
                          : editResult.generatedImages?.[0] ||
                              editResult.editedContent,
                        showOriginal ? "original.jpg" : "ai-edited.jpg",
                      )
                    }
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Download Current
                  </Button>
                </div>

                <div
                  className="relative aspect-video overflow-hidden rounded-lg border bg-card cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => {
                    const imageSrc = showOriginal
                      ? currentItem?.post.imageUrl || ""
                      : editResult.generatedImages?.[0] ||
                        editResult.editedContent;
                    const imageAlt = showOriginal
                      ? "Original Image"
                      : "AI Edited Image";
                    const downloadUrl = showOriginal
                      ? currentItem?.post.imageUrl || ""
                      : editResult.generatedImages?.[0] ||
                        editResult.editedContent;
                    const externalUrl = showOriginal
                      ? currentItem?.post.postUrl
                      : undefined;

                    showImage(imageSrc, imageAlt, downloadUrl, externalUrl);
                  }}
                >
                  <Image
                    src={
                      showOriginal
                        ? currentItem?.post.imageUrl || ""
                        : editResult.generatedImages?.[0] ||
                          editResult.editedContent
                    }
                    alt="Comparison image"
                    fill
                    className="object-cover"
                  />
                </div>
              </div>
            )}

            {/* Edit Details */}
            <Card className="bg-card/80 backdrop-blur-sm border-muted/20 shadow-lg">
              <CardHeader className="bg-gradient-to-r from-muted/20 to-transparent">
                <CardTitle className="text-sm font-semibold text-foreground">
                  Edit Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span>Method:</span>
                  <span className="font-medium">
                    {editResult.method === "google_gemini"
                      ? "Google Gemini API"
                      : editResult.method === "base64"
                        ? "Base64 Upload"
                        : "Direct URL"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Generated:</span>
                  <span className="font-medium">
                    {new Date(editResult.timestamp).toLocaleString()}
                  </span>
                </div>
                {editResult.generatedImages && (
                  <div className="flex justify-between">
                    <span>Images Generated:</span>
                    <span className="font-medium">
                      {editResult.generatedImages.length}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Watermarked Preview + Copy Reply */}
            {watermarkedUrl && (
              <Card className="border-purple-500/30 bg-purple-500/5 shadow-lg">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Copy className="h-4 w-4 text-purple-500" />
                    Watermarked Preview for Reddit Reply
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Full resolution with watermark overlay. Use the button below to copy it with your reply text.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div
                    className="relative aspect-video overflow-hidden rounded-lg border bg-card cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => showImage(watermarkedUrl, "Watermarked Preview", watermarkedUrl)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={watermarkedUrl}
                      alt="Watermarked preview"
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <Button
                    onClick={async () => {
                      try {
                        setCopied(false);
                        const paypalLink = localStorage.getItem("paypal_link") || "";
                        const tipLine = paypalLink
                          ? `A tip is appreciated: ${paypalLink}`
                          : "";
                        const replyText = [
                          "Here is your edit!",
                          "",
                          tipLine,
                          "Reply !solved if you like it",
                        ]
                          .filter(Boolean)
                          .join("\n");

                        // Try to copy image + text to clipboard
                        const blob = await createWatermarkedBlob(
                          editResult.generatedImages?.[0] || editResult.editedContent,
                        );
                        try {
                          await navigator.clipboard.write([
                            new ClipboardItem({
                              "image/png": blob,
                              "text/plain": new Blob([replyText], { type: "text/plain" }),
                            }),
                          ]);
                        } catch {
                          // Fallback: copy text only (some browsers don't support image clipboard)
                          await navigator.clipboard.writeText(replyText);
                        }
                        setCopied(true);
                        setTimeout(() => setCopied(false), 3000);
                      } catch (err) {
                        console.error("Copy failed:", err);
                        alert("Copy failed. Try downloading the image instead.");
                      }
                    }}
                    className="w-full bg-gradient-to-r from-purple-500 to-indigo-500 hover:from-purple-600 hover:to-indigo-600 text-white font-semibold"
                  >
                    {copied ? (
                      <>
                        <ClipboardCheck className="mr-2 h-4 w-4" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy Watermarked Image + Reply Text
                      </>
                    )}
                  </Button>
                  <p className="text-[10px] text-muted-foreground text-center">
                    Copies the watermarked image + reply text to clipboard. Paste into Reddit.
                  </p>
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
