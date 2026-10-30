import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

type DeviceDoc = {
  _id: Types.ObjectId;
  device_id: string;
  hub: Types.ObjectId;
  label?: string;
  last_seen?: Date;
  bound_at?: Date;
  credential_id?: string;
  public_key?: string;
  sign_count?: number;
  transports?: string[];
  revoked?: boolean;
  credential_device_type?: string;
  credential_backed_up?: boolean;
  save: () => Promise<unknown>;
};

type CodeDoc = {
  code_hash: string;
  hub: Types.ObjectId;
  label?: string;
  expires_at: Date;
  used_at?: Date;
  created_by?: string;
  save: () => Promise<unknown>;
};

@Injectable()
export class PosPasskeyService {
  constructor(
    @InjectModel('PosDevice') private readonly deviceModel: Model<DeviceDoc>,
    @InjectModel('PosEnrollmentCode') private readonly codeModel: Model<CodeDoc>,
    @InjectModel('PosTillSequence') private readonly sequenceModel: Model<{ value: number }>,
    @InjectModel('PosWebauthnChallenge') private readonly challengeModel: Model<any>,
  ) {}

  private async tillLabel(hub: Types.ObjectId, existing: DeviceDoc | null) {
    if (existing && String(existing.hub) === String(hub) && /^Till [1-9]\d*$/.test(existing.label || '')) {
      return existing.label;
    }
    const devices = await this.deviceModel.find({ hub }).lean();
    const highest = devices.reduce((max, device) => {
      const match = /^Till ([1-9]\d*)$/.exec(device.label || '');
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    // Reserve numbers atomically, including simultaneous enrollments at this hub.
    const sequence = await this.sequenceModel.findOneAndUpdate(
      { _id: hub },
      [{ $set: { value: { $add: [{ $max: [{ $ifNull: ['$value', 0] }, highest] }, 1] } } }],
      { upsert: true, new: true, updatePipeline: true },
    );
    return `Till ${sequence!.value}`;
  }

  private rpID() {
    if (process.env.POS_RP_ID) return process.env.POS_RP_ID;
    const origin = (process.env.POS_FE_ORIGIN || 'http://localhost:3477').split(',')[0].trim();
    return new URL(origin).hostname;
  }

  private origins() {
    if (process.env.POS_ORIGIN) {
      return process.env.POS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return (process.env.POS_FE_ORIGIN || 'http://localhost:3477')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  hashCode(code: string) {
    return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
  }

  generateCode() {
    const bytes = randomBytes(8);
    return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  codeExpiry() {
    return new Date(Date.now() + CODE_TTL_MS);
  }

  async deviceStatus(deviceId?: string) {
    const id = String(deviceId || '').trim();
    if (!id) return { registered: false, passkey: false };
    const device = await this.deviceModel.findOne({ device_id: id, revoked: { $ne: true } }).lean();
    if (!device) return { registered: false, passkey: false };
    return { registered: true, passkey: Boolean(device.credential_id && device.public_key) };
  }

  private async liveCode(code: string) {
    const row = await this.codeModel.findOne({ code_hash: this.hashCode(code), used_at: null });
    if (!row || row.expires_at.getTime() < Date.now()) {
      throw new ForbiddenException('That registration code is not valid');
    }
    return row;
  }

  private async claimCode(code: string) {
    const now = new Date();
    const row = await this.codeModel.findOneAndUpdate(
      { code_hash: this.hashCode(code), used_at: null, expires_at: { $gt: now } },
      { $set: { used_at: now } },
      { new: true },
    );
    if (!row) throw new ForbiddenException('That registration code is not valid');
    return row;
  }

  private async saveChallenge(deviceId: string, kind: 'registration' | 'authentication', challenge: string) {
    const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS);
    await this.challengeModel.findOneAndUpdate(
      { device_id: deviceId, kind },
      { $set: { challenge, expires_at } },
      { upsert: true },
    );
  }

  private async takeChallenge(deviceId: string, kind: 'registration' | 'authentication') {
    const row = await this.challengeModel.findOneAndDelete({ device_id: deviceId, kind });
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw new ForbiddenException('The till unlock expired. Try again.');
    }
    return String(row.challenge);
  }

  async registrationOptions(deviceId: string, code: string) {
    const id = deviceId.trim();
    if (!id) throw new BadRequestException('deviceId is required');
    const row = await this.liveCode(code);
    const existing = await this.deviceModel.findOne({ device_id: id }).lean();
    if (existing && !existing.revoked && String(existing.hub) !== String(row.hub)) {
      throw new ForbiddenException('This till is already registered to another location');
    }
    const options = await generateRegistrationOptions({
      rpName: 'SalesOS POS',
      rpID: this.rpID(),
      userName: id,
      userID: Buffer.from(id),
      userDisplayName: row.label || 'Store till',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'discouraged',
        requireResidentKey: false,
        userVerification: 'required',
      },
      preferredAuthenticatorType: 'localDevice',
      timeout: 60000,
    });
    await this.saveChallenge(id, 'registration', options.challenge);
    return { options };
  }

  async enroll(input: {
    deviceId: string;
    code: string;
    label?: string;
    response: RegistrationResponseJSON;
  }) {
    const id = input.deviceId.trim();
    if (!id) throw new BadRequestException('deviceId is required');
    const row = await this.liveCode(input.code);
    const expectedChallenge = await this.takeChallenge(id, 'registration');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpID(),
        requireUserVerification: true,
      });
    } catch {
      throw new ForbiddenException('This till could not be registered');
    }
    if (!verification.verified) throw new ForbiddenException('This till could not be registered');
    const credential = verification.registrationInfo.credential;
    const now = new Date();
    const existing = await this.deviceModel.findOne({ device_id: id });
    if (existing && !existing.revoked && String(existing.hub) !== String(row.hub)) {
      throw new ForbiddenException('This till is already registered to another location');
    }
    const claimed = await this.claimCode(input.code);
    const fields = {
      hub: claimed.hub,
      label: await this.tillLabel(claimed.hub, existing),
      last_seen: now,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      sign_count: credential.counter,
      transports: credential.transports,
      revoked: false,
      credential_device_type: verification.registrationInfo.credentialDeviceType,
      credential_backed_up: verification.registrationInfo.credentialBackedUp,
    };
    const doc = existing
      ? await this.deviceModel.findOneAndUpdate({ device_id: id }, { $set: fields }, { new: true })
      : await this.deviceModel.create({ device_id: id, bound_at: now, ...fields });
    // Assertions started for the old credential cannot survive re-enrollment.
    await this.challengeModel.deleteMany({ device_id: id, kind: 'authentication' });
    return {
      deviceId: id,
      hubId: String(claimed.hub),
      credentialId: credential.id,
      label: doc?.label,
    };
  }

  async authenticationOptions(deviceId: string) {
    const id = deviceId.trim();
    const device = await this.deviceModel.findOne({ device_id: id, revoked: { $ne: true } }).lean();
    if (!device) throw new ForbiddenException('This till is not registered');
    if (!device.credential_id || !device.public_key) return { legacy: true as const };
    const options = await generateAuthenticationOptions({
      rpID: this.rpID(),
      allowCredentials: [{ id: device.credential_id, transports: device.transports }],
      userVerification: 'required',
      timeout: 60000,
    });
    await this.saveChallenge(id, 'authentication', options.challenge);
    return { legacy: false as const, options };
  }

  async verifyAssertion(deviceId: string, response: AuthenticationResponseJSON) {
    const device = await this.deviceModel.findOne({ device_id: deviceId, revoked: { $ne: true } });
    if (!device) throw new ForbiddenException('This till is not registered');
    if (!device.credential_id || !device.public_key) return device;
    if (!response) throw new ForbiddenException('This till must be unlocked with its passkey');
    const expectedChallenge = await this.takeChallenge(deviceId, 'authentication');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origins(),
        expectedRPID: this.rpID(),
        requireUserVerification: true,
        credential: {
          id: device.credential_id,
          publicKey: isoBase64URL.toBuffer(device.public_key),
          counter: device.sign_count || 0,
          transports: device.transports,
        },
      });
    } catch {
      throw new ForbiddenException('This till could not be unlocked');
    }
    if (!verification.verified) throw new ForbiddenException('This till could not be unlocked');
    device.sign_count = verification.authenticationInfo.newCounter;
    device.last_seen = new Date();
    await device.save();
    return device;
  }
}
