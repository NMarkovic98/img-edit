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
  const isSolved = data.type === "solved";
  const vibrate =
    Array.isArray(data.vibrate) && data.vibrate.length
      ? data.vibrate
      : isSolved
        ? [500, 200, 500, 200, 500]
        : isReply
        ? [400, 200, 400, 200, 400]
        : [100, 50, 100];

  const title = isSolved ? data.title || "✅ SOLVED EDIT!" : data.title || "Fixtral";
  const options = {
    body: isSolved
      ? `SOLVED · ${data.body || "Someone marked your edit as solved."}`
      : data.body || "New activity on Fixtral",
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
    actions: data.actions ||
      (isSolved
        ? [
            { action: "open", title: "OPEN SOLVED" },
            { action: "dismiss", title: "DISMISS" },
          ]
        : [
            { action: "open", title: "Open" },
            { action: "dismiss", title: "Dismiss" },
          ]),
    tag: data.tag || "fixtral-notification",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const d = event.notification.data || {};
  const rawUrl = d.url || "/app";
  const isAbsolute = /^https?:\/\//i.test(rawUrl);
  const internalUrl = isAbsolute ? "/app" : rawUrl;

  // Always stay inside the app; never navigate notification clicks to Reddit.
  event.waitUntil(
    (async () => {
      const clientList = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

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
      const target = d.postId ? `/app?post=${d.postId}` : internalUrl;
      return clients.openWindow(target);
    })(),
  );
});
