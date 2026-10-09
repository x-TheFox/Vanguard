/**
 * NATS JetStream Client — Aegis IPC Layer
 *
 * Provides a thin wrapper around NATS JetStream for publishing
 * and subscribing to IPC messages between Aegis and Vanguard.
 * All messages are wrapped in IpcEnvelope for tracing.
 */

import { connect, type NatsConnection, type JetStreamClient, type Codec, JSONCodec } from 'nats';
import type { IpcEnvelope } from '@edenvanguard/shared';
import { createCorrelationId } from '@edenvanguard/shared';

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
const codec: Codec<IpcEnvelope> = JSONCodec();

/** Connect to NATS JetStream */
export async function connectNats(): Promise<void> {
  nc = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222' });
  js = nc.jetstream();
  console.error('Aegis connected to NATS JetStream');
}

/** Get the NATS connection */
export function getNats(): NatsConnection {
  if (!nc) throw new Error('NATS not connected. Call connectNats() first.');
  return nc;
}

/** Get the JetStream client */
export function getJetStream(): JetStreamClient {
  if (!js) throw new Error('JetStream not initialized. Call connectNats() first.');
  return js;
}

/** Publish an IPC message to a NATS subject */
export async function publish<T>(
  subject: string,
  payload: T,
  source: 'vanguard' | 'aegis' = 'aegis',
): Promise<void> {
  const jetstream = getJetStream();
  const envelope: IpcEnvelope<T> = {
    correlationId: createCorrelationId(),
    timestamp: new Date().toISOString(),
    source,
    subject,
    payload,
  };
  await jetstream.publish(subject, codec.encode(envelope));
}

/** Subscribe to a NATS subject and handle messages */
export async function subscribe<T>(
  subject: string,
  handler: (envelope: IpcEnvelope<T>) => Promise<void>,
): Promise<void> {
  const nats = getNats();
  const sub = nats.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const envelope = codec.decode(msg.data) as IpcEnvelope<T>;
        await handler(envelope);
      } catch (error) {
        console.error(`Error handling NATS message on ${subject}:`, error);
      }
    }
  })();
}

/** Disconnect from NATS */
export async function disconnectNats(): Promise<void> {
  if (nc) {
    await nc.close();
    nc = null;
    js = null;
  }
}
