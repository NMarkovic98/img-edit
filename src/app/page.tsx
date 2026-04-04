"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Wand2, ArrowRight, Lock, DollarSign } from "lucide-react";
import { useRouter } from "next/navigation";

export default function LandingPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [paypalLink, setPaypalLink] = useState("");
  const [botUrl, setBotUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const saved = localStorage.getItem("reddit_username");
    const token = localStorage.getItem("app_token");
    if (saved && token) {
      router.replace("/app");
    } else {
      // Pre-fill paypal link if previously saved
      const savedPaypal = localStorage.getItem("paypal_link");
      if (savedPaypal) setPaypalLink(savedPaypal);
      const savedBot = localStorage.getItem("bot_url");
      if (savedBot) setBotUrl(savedBot);
      setLoading(false);
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmed = username.trim().replace(/^u\//, "");
    if (!trimmed) return;
    if (!password.trim()) {
      setError("Password is required");
      return;
    }

    // Verify password by making a test API call
    const res = await fetch("/api/push", {
      headers: { Authorization: `Bearer ${password.trim()}` },
    });

    if (res.status === 401) {
      setError("Wrong password");
      return;
    }

    // Password correct — save both
    localStorage.setItem("reddit_username", trimmed);
    localStorage.setItem("app_token", password.trim());
    if (paypalLink.trim()) {
      localStorage.setItem("paypal_link", paypalLink.trim());
    }
    if (botUrl.trim()) {
      localStorage.setItem("bot_url", botUrl.trim());
    }
    router.push("/app");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Wand2 className="h-8 w-8 text-primary animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <Wand2 className="h-10 w-10 text-primary mx-auto" />
          <h1 className="text-2xl font-bold">Fixtral</h1>
          <p className="text-sm text-muted-foreground">
            Enter your credentials to get started
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
              u/
            </span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your_username"
              autoFocus
              className="w-full pl-8 pr-4 py-3 border border-input rounded-lg bg-background text-foreground text-[16px] focus:ring-2 focus:ring-primary/50 focus:border-primary"
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              placeholder="App password"
              className="w-full pl-10 pr-4 py-3 border border-input rounded-lg bg-background text-foreground text-[16px] focus:ring-2 focus:ring-primary/50 focus:border-primary"
            />
          </div>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={paypalLink}
              onChange={(e) => setPaypalLink(e.target.value)}
              placeholder="PayPal.me link (optional)"
              className="w-full pl-10 pr-4 py-3 border border-input rounded-lg bg-background text-foreground text-[16px] focus:ring-2 focus:ring-primary/50 focus:border-primary"
            />
          </div>
          <div className="relative">
            <ArrowRight className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={botUrl}
              onChange={(e) => setBotUrl(e.target.value)}
              placeholder="Reddit bot URL (e.g. http://your-server:3099)"
              className="w-full pl-10 pr-4 py-3 border border-input rounded-lg bg-background text-foreground text-[16px] focus:ring-2 focus:ring-primary/50 focus:border-primary"
            />
          </div>

          {error && <p className="text-sm text-red-500 font-medium">{error}</p>}

          <Button
            type="submit"
            disabled={!username.trim() || !password.trim()}
            className="w-full py-3 font-semibold"
          >
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </form>

        <p className="text-xs text-center text-muted-foreground">
          Protected access — only authorized users can use this app
        </p>
      </div>
    </div>
  );
}
