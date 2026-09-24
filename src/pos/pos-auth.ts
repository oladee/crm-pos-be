import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export type PosJwtPayload = {
  sub: string;
  role: 'cashier' | 'manager';
  hubId: string;
  ownershipType?: string | null;
  deviceId?: string;
};

@Injectable()
export class PosJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('PIN session required');
    try {
      req.posUser = this.jwt.verify<PosJwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException('PIN session expired');
    }
  }
}

export const PosUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PosJwtPayload => {
    const req = ctx.switchToHttp().getRequest();
    if (!req.posUser) throw new UnauthorizedException('PIN session required');
    return req.posUser as PosJwtPayload;
  },
);
