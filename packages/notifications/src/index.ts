/** Notification delivery boundary; templates, jobs, and transports are intentionally deferred. */
export interface NotificationMessage {
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

export interface NotificationSender {
  send(message: NotificationMessage): Promise<void>;
}
