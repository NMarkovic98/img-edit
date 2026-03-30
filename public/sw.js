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

  const options = {
    body: data.body || "New activity on Fixtral",
    icon: data.icon || "/favicon.ico",
    badge: "/favicon.ico",
    vibrate: [100, 50, 100],
    data: {
      url: data.url || "/app",
      postId: data.postId,
    },
    actions: data.actions || [
      { action: "open", title: "Open Fixtral" },
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

  const url = event.notification.data?.url || "/app";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus existing window if available
        for (const client of clientList) {
          if (client.url.includes("/app") && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open new window
        return clients.openWindow(url);
      }),
  );
});
