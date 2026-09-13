export interface DesktopNotifier {
  notify(title: string, body: string, tag?: string): void;
}

export function createDesktopNotifier(): DesktopNotifier {
  return {
    notify(title, body, tag) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "granted") { new Notification(title, { body, ...(tag === undefined ? {} : { tag }) }); return; }
      if (Notification.permission === "default") void Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification(title, { body, ...(tag === undefined ? {} : { tag }) });
      });
    },
  };
}
