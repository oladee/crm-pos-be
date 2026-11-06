import { ArgumentsHost, Catch, Injectable } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { PspAuditService } from './psp-audit.service';
import { auditBody } from './psp-audit';

/** Parser failures happen before the webhook controller can record the delivery. */
@Catch()
@Injectable()
export class PaymentAuditFilter extends BaseExceptionFilter {
  constructor(private readonly audit: PspAuditService, adapter: HttpAdapterHost) { super(adapter.httpAdapter); }

  async catch(error: any, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest();
    const match = String(req.originalUrl || '').split('?')[0].match(/^\/pos\/webhooks\/(squad|bachs|moniepoint\/([^/]+))\/?$/);
    const malformedJson = req.rawBody && req.body === undefined && error?.getStatus?.() === 400;
    if (match && (malformedJson || ['entity.parse.failed', 'entity.too.large'].includes(error?.type))) {
      try {
        await this.audit.append({ provider_id: match[1].startsWith('moniepoint/') ? 'moniepoint' : match[1],
          account_key: match[2] || match[1], exchange_id: randomUUID(), direction: 'inbound', operation: 'webhook',
          stage: 'webhook_result', method: 'POST', verification_result: 'not_verified', outcome: 'parser_rejected',
          http_status: error.status || 400, error_code: error.type || 'entity.parse.failed',
          // Oversized bodies are deliberately not buffered; their claimed size is not trusted.
          ...(req.rawBody ? auditBody(req.rawBody) : {}) });
      } catch {
        return host.switchToHttp().getResponse().status(503).json({ statusCode: 503, message: 'Payment audit storage unavailable; webhook not acknowledged' });
      }
    }
    super.catch(error, host);
  }
}
