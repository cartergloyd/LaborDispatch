/**
 * Minimal Chatwoot Application API client. Chatwoot owns SMS/web-chat transport, inboxes and
 * human handoff; we only post replies and private notes back into the conversation.
 */
export interface ChatwootClientOptions {
  baseUrl: string;
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

export class ChatwootClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: ChatwootClientOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  async sendMessage(conversationId: string | number, content: string, opts: { private?: boolean } = {}) {
    const url = `${this.o.baseUrl}/api/v1/accounts/${this.o.accountId}/conversations/${conversationId}/messages`;
    const res = await this.f(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiToken}`, api_access_token: this.o.apiToken },
      body: JSON.stringify({ content, message_type: "outgoing", private: opts.private ?? false }),
    });
    if (!res.ok) throw new Error(`chatwoot sendMessage failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.json().catch(() => ({}));
  }

  /** Mark the conversation for a human: Chatwoot "open" status + a private note. */
  async handoff(conversationId: string | number, reason: string) {
    await this.sendMessage(conversationId, `LaborDispatch bot handed off: ${reason}`, { private: true });
    const url = `${this.o.baseUrl}/api/v1/accounts/${this.o.accountId}/conversations/${conversationId}/toggle_status`;
    await this.f(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiToken}`, api_access_token: this.o.apiToken },
      body: JSON.stringify({ status: "open" }),
    }).catch(() => undefined);
  }
}
