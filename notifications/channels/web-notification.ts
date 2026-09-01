export type NotifyBroadcast = {
  type: string;
  session: string;
  category: string;
  message: string;
  escalationCount: number;
};

function createWebNotificationChannel(
  broadcast: (msg: NotifyBroadcast) => void,
): (sessionName: string, category: string, message: string, context?: { escalationCount?: number } | null) => void {
  return function webNotificationChannel(sessionName, category, message, context) {
    broadcast({
      type: 'notify',
      session: sessionName,
      category,
      message,
      escalationCount: context?.escalationCount ?? 0,
    });
  };
}

export { createWebNotificationChannel };
