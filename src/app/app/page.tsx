"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueueView } from "@/components/queue-view";
import { EditorView } from "@/components/editor-view";
import { ImageViewerProvider } from "@/components/image-viewer";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Wand2,
  Image,
  Bell,
  BellOff,
  Volume2,
  VolumeX,
  LogOut,
  Radio,
  Info,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { usePushNotifications } from "@/lib/notification-provider";

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("queue");
  const [pendingEditorItems, setPendingEditorItems] = useState(0);
  const [redditUser, setRedditUser] = useState("");
  const [showIconInfo, setShowIconInfo] = useState(false);
  const {
    isSubscribed,
    isSupported,
    isMuted,
    isMonitoring,
    subscribe,
    unsubscribe,
    toggleMute,
    toggleMonitoring,
  } = usePushNotifications();
  const router = useRouter();

  useEffect(() => {
    const user = localStorage.getItem("reddit_username");
    const token = localStorage.getItem("app_token");
    if (!user || !token) {
      router.replace("/");
      return;
    }
    setRedditUser(user);

    // If opened from notification with ?post= param, ensure queue tab is active
    const params = new URLSearchParams(window.location.search);
    if (params.get("post")) {
      setActiveTab("queue");
    }
  }, [router]);

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "pendingEditorItem" && e.newValue) {
        setActiveTab("editor");
        updatePendingCount();
      }
    };

    const updatePendingCount = () => {
      const pendingItem = localStorage.getItem("pendingEditorItem");
      setPendingEditorItems(pendingItem ? 1 : 0);
    };

    updatePendingCount();
    window.addEventListener("storage", handleStorageChange);

    const pendingItem = localStorage.getItem("pendingEditorItem");
    if (pendingItem) {
      setActiveTab("editor");
    }

    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  const handleLogout = () => {
    localStorage.removeItem("reddit_username");
    localStorage.removeItem("app_token");
    router.replace("/");
  };

  return (
    <ImageViewerProvider>
      <div className="min-h-screen bg-background">
        {/* Header */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto px-3 sm:px-4 py-2 sm:py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 sm:space-x-3">
                <Wand2 className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
                <span className="font-bold text-sm sm:text-lg">Fixtral</span>
                {redditUser && (
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    u/{redditUser}
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-1">
                {redditUser && (
                  <span className="text-xs text-muted-foreground sm:hidden mr-1">
                    u/{redditUser}
                  </span>
                )}
                {isSupported && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => (isSubscribed ? unsubscribe() : subscribe())}
                    className="touch-target relative h-9 w-9 p-0"
                    title={
                      isSubscribed
                        ? "Disable push notifications"
                        : "Enable push notifications"
                    }
                  >
                    {isSubscribed ? (
                      <Bell className="h-4 w-4 text-green-500" />
                    ) : (
                      <BellOff className="h-4 w-4 text-muted-foreground" />
                    )}
                    {isSubscribed && (
                      <div className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full"></div>
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleMute}
                  className="touch-target relative h-9 w-9 p-0"
                  title={
                    isMuted
                      ? "Unmute notifications (chime & speech)"
                      : "Mute notifications (chime & speech)"
                  }
                >
                  {isMuted ? (
                    <VolumeX className="h-4 w-4 text-red-500" />
                  ) : (
                    <Volume2 className="h-4 w-4 text-green-500" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleMonitoring}
                  className="touch-target relative h-9 w-9 p-0"
                  title={
                    isMonitoring
                      ? "Background monitor ON — push notifications even when tab is closed"
                      : "Background monitor OFF — enable to get push when tab is closed"
                  }
                >
                  <Radio
                    className={`h-4 w-4 ${isMonitoring ? "text-green-500" : "text-muted-foreground"}`}
                  />
                  {isMonitoring && (
                    <div className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  )}
                </Button>
                <ThemeToggle />
                <div className="relative sm:hidden">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowIconInfo(!showIconInfo)}
                    className="touch-target h-9 w-9 p-0"
                    title="What do these icons mean?"
                  >
                    <Info className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  {showIconInfo && (
                    <div className="absolute right-0 top-10 z-50 w-56 rounded-lg border bg-popover p-3 shadow-lg text-xs space-y-2">
                      <div className="flex items-center gap-2">
                        <Bell className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                        <span>Push notifications on/off</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Volume2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                        <span>Sound notifications on/off</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Radio className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                        <span>Background monitor (push when tab closed)</span>
                      </div>
                      <button
                        onClick={() => setShowIconInfo(false)}
                        className="text-muted-foreground hover:text-foreground text-[10px] pt-1"
                      >
                        Tap to close
                      </button>
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  className="touch-target h-9 w-9 p-0"
                  title="Change Reddit username"
                >
                  <LogOut className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="container mx-auto px-3 sm:px-4 py-3 sm:py-6">
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="w-full"
          >
            <TabsList className="grid w-full max-w-full grid-cols-2 h-10 sm:h-11 p-1 bg-muted/50 border overflow-hidden">
              <TabsTrigger
                value="queue"
                className="flex items-center justify-center gap-1.5 h-8 sm:h-9 rounded-md font-medium text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm min-w-0"
              >
                <Image className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Queue</span>
              </TabsTrigger>
              <TabsTrigger
                value="editor"
                className="flex items-center justify-center gap-1.5 h-8 sm:h-9 rounded-md font-medium text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm relative min-w-0"
              >
                <Wand2 className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Editor</span>
                {pendingEditorItems > 0 && (
                  <div className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold animate-pulse">
                    {pendingEditorItems}
                  </div>
                )}
              </TabsTrigger>
            </TabsList>

            <div className={`mt-3 sm:mt-4 ${activeTab === "queue" ? "" : "hidden"}`}>
              <QueueView />
            </div>

            <div className={`mt-3 sm:mt-4 ${activeTab === "editor" ? "" : "hidden"}`}>
              <EditorView />
            </div>
          </Tabs>
        </main>
      </div>
    </ImageViewerProvider>
  );
}
