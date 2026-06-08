"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { QueueView } from "@/components/queue-view";
import { ImageViewerProvider } from "@/components/image-viewer";
import { ThemeToggle } from "@/components/theme-toggle";
import { Bell, BellOff, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { usePushNotifications } from "@/lib/notification-provider";

export default function Dashboard() {
  const [redditUser, setRedditUser] = useState("");
  const {
    isSubscribed,
    isSupported,
    isMuted,
    isMonitoring,
    subscribe,
    toggleMute,
    toggleMonitoring,
  } = usePushNotifications();
  const router = useRouter();

  const requestNotificationsOn = isSubscribed && !isMuted && isMonitoring;
  const toggleAllNotifications = async () => {
    if (requestNotificationsOn) {
      if (isMonitoring) toggleMonitoring();
    } else {
      if (!isSubscribed) await subscribe();
      if (isMuted) toggleMute();
      if (!isMonitoring) toggleMonitoring();
    }
  };

  useEffect(() => {
    const user = "deandean91";
    const token = localStorage.getItem("app_token");
    if (!token) {
      router.replace("/");
      return;
    }
    localStorage.setItem("reddit_username", user);
    setRedditUser(user);
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem("reddit_username");
    localStorage.removeItem("app_token");
    router.replace("/");
  };

  return (
    <ImageViewerProvider>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto px-3 sm:px-4 py-2 sm:py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground truncate max-w-[140px] sm:max-w-none">
                u/{redditUser || "..."}
              </span>

              <div className="flex items-center gap-1">
                {isSupported && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllNotifications}
                    className="relative h-9 w-9 p-0"
                    title={
                      requestNotificationsOn
                        ? "Auto-refresh + push ON — tap to disable"
                        : "Enable auto-refresh + push notifications"
                    }
                  >
                    {requestNotificationsOn ? (
                      <Bell className="h-4 w-4 text-green-500" />
                    ) : (
                      <BellOff className="h-4 w-4 text-muted-foreground" />
                    )}
                    {requestNotificationsOn && (
                      <div className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full" />
                    )}
                  </Button>
                )}

                <ThemeToggle />

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  className="h-9 w-9 p-0"
                  title="Log out"
                >
                  <LogOut className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          </div>
        </header>

        <main className="container mx-auto px-3 sm:px-4 py-3 sm:py-6">
          <QueueView />
        </main>
      </div>
    </ImageViewerProvider>
  );
}
