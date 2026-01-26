/**
 * ActivityPub Federation Bridge
 *
 * Implements ActivityPub protocol for federation with Mastodon, Pleroma,
 * and other ActivityPub-compatible services.
 *
 * Spec: https://www.w3.org/TR/activitypub/
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// =============================================================================
// Types
// =============================================================================

export type ActivityType =
  | 'Create'
  | 'Update'
  | 'Delete'
  | 'Follow'
  | 'Accept'
  | 'Reject'
  | 'Add'
  | 'Remove'
  | 'Like'
  | 'Announce'
  | 'Undo';

export type ObjectType =
  | 'Note'
  | 'Article'
  | 'Person'
  | 'Application'
  | 'Group'
  | 'Organization'
  | 'Service'
  | 'Collection'
  | 'OrderedCollection';

export interface ActivityPubObject {
  '@context'?: string | string[];
  id: string;
  type: ObjectType | ObjectType[];
  name?: string;
  summary?: string;
  content?: string;
  url?: string;
  published?: string;
  updated?: string;
  attributedTo?: string | ActivityPubObject;
  to?: string[];
  cc?: string[];
  inReplyTo?: string;
  attachment?: ActivityPubAttachment[];
  tag?: ActivityPubTag[];
  [key: string]: unknown;
}

export interface ActivityPubActivity {
  '@context': string | string[];
  id: string;
  type: ActivityType;
  actor: string;
  object: string | ActivityPubObject | ActivityPubActivity;
  target?: string | ActivityPubObject;
  published?: string;
  to?: string[];
  cc?: string[];
  [key: string]: unknown;
}

export interface ActivityPubActor {
  '@context': string | string[];
  id: string;
  type: ObjectType;
  preferredUsername: string;
  name?: string;
  summary?: string;
  url?: string;
  inbox: string;
  outbox: string;
  followers?: string;
  following?: string;
  liked?: string;
  publicKey?: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  icon?: ActivityPubAttachment;
  image?: ActivityPubAttachment;
  endpoints?: {
    sharedInbox?: string;
  };
}

export interface ActivityPubAttachment {
  type: string;
  mediaType?: string;
  url: string;
  name?: string;
  width?: number;
  height?: number;
}

export interface ActivityPubTag {
  type: 'Hashtag' | 'Mention' | 'Emoji';
  href?: string;
  name: string;
  icon?: ActivityPubAttachment;
}

export interface ActivityPubCollection {
  '@context': string | string[];
  id: string;
  type: 'Collection' | 'OrderedCollection';
  totalItems: number;
  first?: string | ActivityPubCollectionPage;
  last?: string;
  items?: (string | ActivityPubObject)[];
  orderedItems?: (string | ActivityPubObject)[];
}

export interface ActivityPubCollectionPage {
  '@context': string | string[];
  id: string;
  type: 'CollectionPage' | 'OrderedCollectionPage';
  partOf: string;
  next?: string;
  prev?: string;
  items?: (string | ActivityPubObject)[];
  orderedItems?: (string | ActivityPubObject)[];
}

export interface WebFingerResponse {
  subject: string;
  aliases?: string[];
  links: Array<{
    rel: string;
    type?: string;
    href?: string;
    template?: string;
  }>;
}

export interface ActivityPubBridgeConfig {
  domain: string;
  baseUrl: string;
  privateKey?: string;
  publicKey?: string;
}

export interface FederatedMessage {
  id: string;
  type: 'note' | 'follow' | 'accept' | 'reject' | 'announce' | 'like';
  fromActorId: string;
  toActorIds: string[];
  content?: string;
  inReplyTo?: string;
  attachments?: ActivityPubAttachment[];
  tags?: ActivityPubTag[];
  originalActivity?: ActivityPubActivity;
  createdAt: Date;
}

// =============================================================================
// ActivityPub Bridge Service
// =============================================================================

export class ActivityPubBridge extends EventEmitter {
  private config: ActivityPubBridgeConfig;
  private actors: Map<string, ActivityPubActor> = new Map();
  private inbox: Map<string, ActivityPubActivity[]> = new Map();
  private outbox: Map<string, ActivityPubActivity[]> = new Map();
  private followers: Map<string, Set<string>> = new Map();
  private following: Map<string, Set<string>> = new Map();

  static readonly CONTEXT = [
    'https://www.w3.org/ns/activitystreams',
    'https://w3id.org/security/v1'
  ];

  static readonly PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

  constructor(config: ActivityPubBridgeConfig) {
    super();
    this.config = config;

    // Generate keypair if not provided
    if (!config.privateKey || !config.publicKey) {
      const { publicKey, privateKey } = this.generateKeyPair();
      this.config.publicKey = publicKey;
      this.config.privateKey = privateKey;
    }
  }

  // ==========================================================================
  // Key Management
  // ==========================================================================

  private generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
  }

  // ==========================================================================
  // Actor Management
  // ==========================================================================

  createActor(brokerId: string, profile: {
    username: string;
    displayName?: string;
    summary?: string;
    icon?: string;
  }): ActivityPubActor {
    const actorId = `${this.config.baseUrl}/users/${profile.username}`;

    const actor: ActivityPubActor = {
      '@context': ActivityPubBridge.CONTEXT,
      id: actorId,
      type: 'Person',
      preferredUsername: profile.username,
      name: profile.displayName || profile.username,
      summary: profile.summary,
      url: actorId,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`,
      followers: `${actorId}/followers`,
      following: `${actorId}/following`,
      publicKey: {
        id: `${actorId}#main-key`,
        owner: actorId,
        publicKeyPem: this.config.publicKey!
      },
      endpoints: {
        sharedInbox: `${this.config.baseUrl}/inbox`
      }
    };

    if (profile.icon) {
      actor.icon = {
        type: 'Image',
        mediaType: 'image/png',
        url: profile.icon
      };
    }

    this.actors.set(brokerId, actor);
    this.inbox.set(actorId, []);
    this.outbox.set(actorId, []);
    this.followers.set(actorId, new Set());
    this.following.set(actorId, new Set());

    return actor;
  }

  getActor(brokerId: string): ActivityPubActor | undefined {
    return this.actors.get(brokerId);
  }

  getActorById(actorId: string): ActivityPubActor | undefined {
    for (const actor of this.actors.values()) {
      if (actor.id === actorId) {
        return actor;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // WebFinger Support
  // ==========================================================================

  generateWebFinger(username: string): WebFingerResponse {
    const actorId = `${this.config.baseUrl}/users/${username}`;

    return {
      subject: `acct:${username}@${this.config.domain}`,
      aliases: [actorId],
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorId
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: actorId
        }
      ]
    };
  }

  async resolveWebFinger(acct: string): Promise<WebFingerResponse | null> {
    // Parse acct:user@domain format
    const match = acct.match(/^(?:acct:)?([^@]+)@(.+)$/);
    if (!match) return null;

    const [, username, domain] = match;
    const webFingerUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;

    try {
      const response = await fetch(webFingerUrl, {
        headers: { 'Accept': 'application/jrd+json, application/json' }
      });
      if (!response.ok) return null;
      return await response.json() as WebFingerResponse;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Activity Creation
  // ==========================================================================

  createNote(actorId: string, content: string, options: {
    to?: string[];
    cc?: string[];
    inReplyTo?: string;
    attachments?: ActivityPubAttachment[];
    tags?: ActivityPubTag[];
    sensitive?: boolean;
  } = {}): ActivityPubActivity {
    const noteId = `${actorId}/notes/${uuidv4()}`;
    const now = new Date().toISOString();

    const note: ActivityPubObject = {
      '@context': ActivityPubBridge.CONTEXT,
      id: noteId,
      type: 'Note',
      attributedTo: actorId,
      content,
      published: now,
      to: options.to || [ActivityPubBridge.PUBLIC],
      cc: options.cc || [`${actorId}/followers`],
      inReplyTo: options.inReplyTo,
      attachment: options.attachments,
      tag: options.tags
    };

    if (options.sensitive) {
      (note as any).sensitive = true;
    }

    const activity: ActivityPubActivity = {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${noteId}/activity`,
      type: 'Create',
      actor: actorId,
      object: note,
      published: now,
      to: note.to,
      cc: note.cc
    };

    return activity;
  }

  createFollow(actorId: string, targetActorId: string): ActivityPubActivity {
    return {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${actorId}/follows/${uuidv4()}`,
      type: 'Follow',
      actor: actorId,
      object: targetActorId,
      published: new Date().toISOString()
    };
  }

  createAccept(actorId: string, followActivity: ActivityPubActivity): ActivityPubActivity {
    return {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${actorId}/accepts/${uuidv4()}`,
      type: 'Accept',
      actor: actorId,
      object: followActivity,
      published: new Date().toISOString()
    };
  }

  createReject(actorId: string, followActivity: ActivityPubActivity): ActivityPubActivity {
    return {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${actorId}/rejects/${uuidv4()}`,
      type: 'Reject',
      actor: actorId,
      object: followActivity,
      published: new Date().toISOString()
    };
  }

  createLike(actorId: string, objectId: string): ActivityPubActivity {
    return {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${actorId}/likes/${uuidv4()}`,
      type: 'Like',
      actor: actorId,
      object: objectId,
      published: new Date().toISOString()
    };
  }

  createAnnounce(actorId: string, objectId: string, to?: string[]): ActivityPubActivity {
    return {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${actorId}/announces/${uuidv4()}`,
      type: 'Announce',
      actor: actorId,
      object: objectId,
      published: new Date().toISOString(),
      to: to || [ActivityPubBridge.PUBLIC],
      cc: [`${actorId}/followers`]
    };
  }

  createUndo(actorId: string, activity: ActivityPubActivity): ActivityPubActivity {
    return {
      '@context': ActivityPubBridge.CONTEXT,
      id: `${actorId}/undos/${uuidv4()}`,
      type: 'Undo',
      actor: actorId,
      object: activity,
      published: new Date().toISOString()
    };
  }

  // ==========================================================================
  // HTTP Signature
  // ==========================================================================

  signRequest(actorId: string, method: string, url: string, body?: string): {
    signature: string;
    date: string;
    digest?: string;
  } {
    const date = new Date().toUTCString();
    const parsedUrl = new URL(url);

    const headers: string[] = ['(request-target)', 'host', 'date'];
    const signatureString: string[] = [
      `(request-target): ${method.toLowerCase()} ${parsedUrl.pathname}`,
      `host: ${parsedUrl.host}`,
      `date: ${date}`
    ];

    let digest: string | undefined;
    if (body) {
      digest = `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`;
      headers.push('digest');
      signatureString.push(`digest: ${digest}`);
    }

    const signData = signatureString.join('\n');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signData);
    const signature = sign.sign(this.config.privateKey!, 'base64');

    const signatureHeader = [
      `keyId="${actorId}#main-key"`,
      `headers="${headers.join(' ')}"`,
      `signature="${signature}"`,
      `algorithm="rsa-sha256"`
    ].join(',');

    return { signature: signatureHeader, date, digest };
  }

  verifySignature(
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    publicKeyPem: string
  ): boolean {
    try {
      // Parse signature header
      const sigParams: Record<string, string> = {};
      signature.split(',').forEach(part => {
        const [key, ...valueParts] = part.split('=');
        sigParams[key.trim()] = valueParts.join('=').replace(/^"|"$/g, '');
      });

      const headerNames = sigParams.headers.split(' ');
      const signatureString = headerNames.map(h => {
        if (h === '(request-target)') {
          return `(request-target): ${method.toLowerCase()} ${path}`;
        }
        return `${h}: ${headers[h.toLowerCase()]}`;
      }).join('\n');

      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(signatureString);
      return verify.verify(publicKeyPem, sigParams.signature, 'base64');
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Inbox/Outbox
  // ==========================================================================

  async processInboxActivity(actorId: string, activity: ActivityPubActivity): Promise<void> {
    const inboxActivities = this.inbox.get(actorId) || [];
    inboxActivities.push(activity);
    this.inbox.set(actorId, inboxActivities);

    // Convert to federated message and emit
    const message = this.activityToMessage(activity);
    this.emit('message:received', message);

    // Handle specific activity types
    switch (activity.type) {
      case 'Follow':
        this.emit('follow:received', {
          fromActorId: activity.actor,
          toActorId: actorId,
          activity
        });
        break;

      case 'Accept':
        if (typeof activity.object === 'object' && activity.object.type === 'Follow') {
          const followingSet = this.following.get(activity.object.actor as string);
          if (followingSet) {
            followingSet.add(activity.actor);
          }
          this.emit('follow:accepted', {
            fromActorId: activity.actor,
            activity
          });
        }
        break;

      case 'Reject':
        this.emit('follow:rejected', {
          fromActorId: activity.actor,
          activity
        });
        break;

      case 'Create':
        this.emit('note:received', {
          fromActorId: activity.actor,
          object: activity.object,
          activity
        });
        break;

      case 'Like':
        this.emit('like:received', {
          fromActorId: activity.actor,
          objectId: activity.object,
          activity
        });
        break;

      case 'Announce':
        this.emit('boost:received', {
          fromActorId: activity.actor,
          objectId: activity.object,
          activity
        });
        break;

      case 'Undo':
        this.emit('undo:received', {
          fromActorId: activity.actor,
          activity
        });
        break;
    }
  }

  addToOutbox(actorId: string, activity: ActivityPubActivity): void {
    const outboxActivities = this.outbox.get(actorId) || [];
    outboxActivities.push(activity);
    this.outbox.set(actorId, outboxActivities);
  }

  getInbox(actorId: string, page?: number, pageSize: number = 20): ActivityPubCollection {
    const activities = this.inbox.get(actorId) || [];
    return this.createCollection(`${actorId}/inbox`, activities, page, pageSize);
  }

  getOutbox(actorId: string, page?: number, pageSize: number = 20): ActivityPubCollection {
    const activities = this.outbox.get(actorId) || [];
    return this.createCollection(`${actorId}/outbox`, activities, page, pageSize);
  }

  // ==========================================================================
  // Followers/Following
  // ==========================================================================

  addFollower(actorId: string, followerActorId: string): void {
    const followersSet = this.followers.get(actorId);
    if (followersSet) {
      followersSet.add(followerActorId);
    }
  }

  removeFollower(actorId: string, followerActorId: string): void {
    const followersSet = this.followers.get(actorId);
    if (followersSet) {
      followersSet.delete(followerActorId);
    }
  }

  getFollowers(actorId: string): ActivityPubCollection {
    const followersSet = this.followers.get(actorId) || new Set();
    const followers = Array.from(followersSet);
    return this.createCollection(`${actorId}/followers`, followers);
  }

  getFollowing(actorId: string): ActivityPubCollection {
    const followingSet = this.following.get(actorId) || new Set();
    const following = Array.from(followingSet);
    return this.createCollection(`${actorId}/following`, following);
  }

  // ==========================================================================
  // Delivery
  // ==========================================================================

  async deliverActivity(activity: ActivityPubActivity, targetInbox: string): Promise<boolean> {
    try {
      const body = JSON.stringify(activity);
      const { signature, date, digest } = this.signRequest(
        activity.actor,
        'POST',
        targetInbox,
        body
      );

      const headers: Record<string, string> = {
        'Content-Type': 'application/activity+json',
        'Accept': 'application/activity+json',
        'Date': date,
        'Signature': signature
      };

      if (digest) {
        headers['Digest'] = digest;
      }

      const response = await fetch(targetInbox, {
        method: 'POST',
        headers,
        body
      });

      const success = response.ok || response.status === 202;

      if (success) {
        this.addToOutbox(activity.actor, activity);
      }

      return success;
    } catch (error) {
      console.error('ActivityPub delivery failed:', error);
      return false;
    }
  }

  async deliverToFollowers(actorId: string, activity: ActivityPubActivity): Promise<{ delivered: number; failed: number }> {
    const followersSet = this.followers.get(actorId) || new Set();
    let delivered = 0;
    let failed = 0;

    for (const followerActorId of followersSet) {
      try {
        // Fetch follower's inbox
        const actor = await this.fetchRemoteActor(followerActorId);
        if (actor?.inbox) {
          const success = await this.deliverActivity(activity, actor.inbox);
          if (success) {
            delivered++;
          } else {
            failed++;
          }
        }
      } catch {
        failed++;
      }
    }

    return { delivered, failed };
  }

  // ==========================================================================
  // Remote Actor Fetching
  // ==========================================================================

  async fetchRemoteActor(actorId: string): Promise<ActivityPubActor | null> {
    try {
      const response = await fetch(actorId, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json'
        }
      });

      if (!response.ok) return null;

      const actor = await response.json();
      return actor as ActivityPubActor;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private createCollection(
    id: string,
    items: (string | ActivityPubObject | ActivityPubActivity)[],
    page?: number,
    pageSize: number = 20
  ): ActivityPubCollection {
    const total = items.length;

    if (page !== undefined) {
      const start = page * pageSize;
      const pageItems = items.slice(start, start + pageSize);

      return {
        '@context': ActivityPubBridge.CONTEXT,
        id: `${id}?page=${page}`,
        type: 'OrderedCollectionPage',
        partOf: id,
        totalItems: total,
        orderedItems: pageItems,
        next: start + pageSize < total ? `${id}?page=${page + 1}` : undefined,
        prev: page > 0 ? `${id}?page=${page - 1}` : undefined
      } as any;
    }

    return {
      '@context': ActivityPubBridge.CONTEXT,
      id,
      type: 'OrderedCollection',
      totalItems: total,
      first: total > 0 ? `${id}?page=0` : undefined,
      orderedItems: items.slice(0, pageSize) as (string | ActivityPubObject)[]
    };
  }

  private activityToMessage(activity: ActivityPubActivity): FederatedMessage {
    let type: FederatedMessage['type'] = 'note';
    let content: string | undefined;

    switch (activity.type) {
      case 'Follow':
        type = 'follow';
        break;
      case 'Accept':
        type = 'accept';
        break;
      case 'Reject':
        type = 'reject';
        break;
      case 'Announce':
        type = 'announce';
        break;
      case 'Like':
        type = 'like';
        break;
      case 'Create':
        type = 'note';
        if (typeof activity.object === 'object') {
          content = (activity.object as ActivityPubObject).content;
        }
        break;
    }

    return {
      id: activity.id,
      type,
      fromActorId: activity.actor,
      toActorIds: [...(activity.to || []), ...(activity.cc || [])],
      content,
      originalActivity: activity,
      createdAt: activity.published ? new Date(activity.published) : new Date()
    };
  }

  // ==========================================================================
  // Stats
  // ==========================================================================

  getStats(): {
    actors: number;
    totalFollowers: number;
    totalFollowing: number;
    inboxActivities: number;
    outboxActivities: number;
  } {
    let totalFollowers = 0;
    let totalFollowing = 0;
    let inboxActivities = 0;
    let outboxActivities = 0;

    for (const set of this.followers.values()) {
      totalFollowers += set.size;
    }
    for (const set of this.following.values()) {
      totalFollowing += set.size;
    }
    for (const activities of this.inbox.values()) {
      inboxActivities += activities.length;
    }
    for (const activities of this.outbox.values()) {
      outboxActivities += activities.length;
    }

    return {
      actors: this.actors.size,
      totalFollowers,
      totalFollowing,
      inboxActivities,
      outboxActivities
    };
  }
}
