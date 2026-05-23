// Fixtral Service Worker for Push Notifications

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = {
      title: "Fixtral",
      body: event.data.text(),
      icon: "/favicon.ico",
    };
  }

  const isReply = data.type === "reply";
  const vibrate =
    Array.isArray(data.vibrate) && data.vibrate.length
      ? data.vibrate
      : isReply
        ? [400, 200, 400, 200, 400]
        : [100, 50, 100];

  const options = {
    body: data.body || "New activity on Fixtral",
    icon: data.icon || "/favicon.ico",
    badge: "/favicon.ico",
    vibrate,
    requireInteraction: !!data.requireInteraction,
    data: {
      url: data.url || "/app",
      postId: data.postId,
      replyId: data.replyId,
      type: data.type,
    },
    actions: data.actions || [
      { action: "open", title: "Open" },
      { action: "dismiss", title: "Dismiss" },
    ],
    tag: data.tag || "fixtral-notification",
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Fixtral", options),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const d = event.notification.data || {};
  const rawUrl = d.url || "/app";
  const isAbsolute = /^https?:\/\//i.test(rawUrl);
  const isReply = d.type === "reply";

  // For reply notifications with an absolute (Reddit) URL, open that URL directly.
  // For everything else, focus an existing /app tab and deep-link to the post.
  event.waitUntil(
    (async () => {
      const clientList = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      if (isReply && isAbsolute) {
        // Try to reuse an existing tab pointed at the same Reddit URL; otherwise open new
        for (const client of clientList) {
          if (client.url === rawUrl && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow(rawUrl);
      }

      // Default: focus app tab, deep-link via postId
      for (const client of clientList) {
        if (client.url.includes("/app") && "focus" in client) {
          client.focus();
          if (d.postId) {
            client.postMessage({
              type: "NAVIGATE_TO_POST",
              postId: d.postId,
            });
          }
          return;
        }
      }
      const target = d.postId ? `/app?post=${d.postId}` : rawUrl;
      return clients.openWindow(target);
    })(),
  );
});
