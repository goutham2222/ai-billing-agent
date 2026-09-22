export interface EvolutionMessageKey {
  remoteJid: string;
  fromMe: boolean;
  id: string;
  participant?: string;
}

export interface EvolutionMediaMessage {
  url?: string;
  mimetype?: string;
  fileSha256?: string;
  fileLength?: number | string;
  mediaKey?: string;
  caption?: string;
  seconds?: number;
  ptt?: boolean;
}

export interface EvolutionButtonReply {
  selectedButtonId?: string;
  selectedId?: string;
  selectedDisplayText?: string;
}

export interface EvolutionMessageContent {
  conversation?: string;
  extendedTextMessage?: {
    text: string;
  };
  imageMessage?: EvolutionMediaMessage;
  audioMessage?: EvolutionMediaMessage;
  documentMessage?: EvolutionMediaMessage & { fileName?: string };
  buttonsResponseMessage?: EvolutionButtonReply;
  templateButtonReplyMessage?: EvolutionButtonReply;
  [key: string]: unknown;
}

export interface EvolutionWebhookData {
  key: EvolutionMessageKey;
  pushName?: string;
  message?: EvolutionMessageContent;
  messageType?: string;
  messageTimestamp?: number | string;
  instanceId?: string;
  source?: string;
  [key: string]: unknown;
}

export interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  data: EvolutionWebhookData;
  destination?: string;
  date_time?: string;
  sender?: string;
  server_url?: string;
  apikey?: string;
}
