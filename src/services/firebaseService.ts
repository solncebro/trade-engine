import { EventEmitter } from 'events';

import admin from 'firebase-admin';

import { logger } from '../core/logger';
export interface FirebaseServiceArgs<T> {
  documentPath: string;
  defaultData: T;
  onNotify: (message: string) => void | Promise<void>;
  onError: (message: string, error: unknown) => void | Promise<void>;
}

export class FirebaseService<T> extends EventEmitter {
  private firestore: admin.firestore.Firestore;
  private documentReference: admin.firestore.DocumentReference;
  private settingsListener: (() => void) | null = null;
  private currentData: T;
  private defaultData: T;
  protected onNotify: (message: string) => void | Promise<void>;
  protected onError: (message: string, error: unknown) => void | Promise<void>;

  constructor(args: FirebaseServiceArgs<T>) {
    super();

    const { documentPath, defaultData, onNotify, onError } = args;

    this.defaultData = defaultData;
    this.currentData = { ...defaultData };
    this.onNotify = onNotify;
    this.onError = onError;

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }

    this.firestore = admin.firestore();
    this.documentReference = this.firestore.doc(documentPath);
  }

  public async initialize(): Promise<void> {
    try {
      const document = await this.documentReference.get();

      if (document.exists) {
        const data = document.data() as T;
        this.updateCurrentData(data);
      } else {
        await this.notify('No data found in Firebase, using defaults');
      }

      this.subscribeToDataChanges();
    } catch (error) {
      await this.notifyError('Failed to initialize Firebase service', error);

      throw error;
    }
  }

  private subscribeToDataChanges(): void {
    this.settingsListener = this.documentReference.onSnapshot(document => {
      if (document.exists) {
        const data = document.data() as T;
        const previousData = { ...this.currentData };
        this.updateCurrentData(data);

        logger.info(
          {
            previous: previousData,
            current: this.currentData,
          },
          'Data updated from Firebase'
        );

        this.emit('dataChanged', {
          current: this.currentData,
          previous: previousData,
        });
      }
    });
  }

  private updateCurrentData(data: Partial<T>): void {
    this.currentData = { ...this.defaultData, ...data };
  }

  public getData(): T {
    return this.currentData;
  }

  public async updateData(data: Partial<T>): Promise<void> {
    try {
      await this.documentReference.update(data);

      logger.info({ data }, 'Updated data in Firebase');
    } catch (error) {
      logger.error({ error, data }, 'Failed to update data in Firebase');

      throw error;
    }
  }

  public getDocumentReference(): admin.firestore.DocumentReference {
    return this.documentReference;
  }

  public getFirestore(): admin.firestore.Firestore {
    return this.firestore;
  }

  private async notify(message: string): Promise<void> {
    await this.onNotify(message);
  }

  private async notifyError(message: string, error: unknown): Promise<void> {
    await this.onError(message, error);
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.settingsListener) {
        this.settingsListener();
        this.settingsListener = null;
      }

      await admin.app().delete();

      logger.info('Firebase service disconnected');
    } catch (error) {
      logger.error({ error }, 'Error disconnecting Firebase service');
    }
  }
}
