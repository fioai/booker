import {
  authenticateOwner,
  createAdminSessionStore,
  type AdminSession,
  type AdminSessionStore,
} from './auth.js';
import {
  AdminHttpError,
  type AdminHttpApi,
  type AdminHttpApiDependencies,
  type AdminHttpApiOptions,
  type AdminHttpRequest,
  type AdminHttpResponse,
} from './contracts.js';
import { parseAdminRoute } from './routes.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  bodyWithoutCsrf,
  clearedCookie,
  cookie,
  headerValue,
  newCsrfToken,
  normalizedOrigin,
  parseCookies,
  recordForCsrf,
  requireAllowedKeys,
  requireBookingMutation,
  requireCsrf,
  requireMutation,
  requireNoBodyFields,
  requirePrivateRead,
  requireRecord,
  requireSession,
  type ParsedCookies,
} from './security.js';
import {
  errorResponse,
  mapPersistenceError,
  methodNotAllowed,
  notFound,
  pageData,
  response,
  serializeBookingRequest,
  serializeHealth,
  serializeManualBlock,
  serializeProperty,
  serializeRatePlan,
  serializeUser,
} from './serialization.js';
import { loadProperty, scopeFor, scopedBookingRequest } from './scope.js';
import {
  canonicalProperty,
  validateManualBlockInput,
  validatePropertyUpdate,
  validateRateInput,
  validIdentifier,
} from './validation.js';
import { escapeHtml, renderPropertyPage } from './views/property-page.js';

const MAX_MANUAL_BLOCKS = 10_000;

export function createAdminHttpApi(
  dependencies: AdminHttpApiDependencies,
  options: AdminHttpApiOptions = {},
): AdminHttpApi {
  const secureCookies = options.secureCookies ?? true;
  const expectedOrigin = normalizedOrigin(options.origin);
  const sessions: AdminSessionStore =
    options.sessionStore ?? createAdminSessionStore(options.session);
  const sessionMaxAge = Math.floor(8 * 60 * 60);
  const renderPage = options.renderPropertyPage ?? renderPropertyPage;

  function setCsrfCookie(token: string): string {
    return cookie(CSRF_COOKIE, token, {
      secure: secureCookies,
      httpOnly: false,
      maxAge: sessionMaxAge,
    });
  }

  function csrfCookieHeaders(
    session: AdminSession,
    cookies: ParsedCookies,
  ): Readonly<Record<string, string>> {
    const token = session.csrfToken ?? cookies[CSRF_COOKIE];
    if (token === undefined) {
      throw new AdminHttpError(401, 'invalid_session', 'A valid admin session is required.');
    }
    return { 'set-cookie': setCsrfCookie(token) };
  }

  function sessionCookies(ticket: {
    readonly token: string;
    readonly csrfToken: string;
  }): readonly string[] {
    return [
      cookie(SESSION_COOKIE, ticket.token, {
        secure: secureCookies,
        httpOnly: true,
        maxAge: sessionMaxAge,
      }),
      setCsrfCookie(ticket.csrfToken),
    ];
  }

  async function requireCsrfThenRecord(
    request: AdminHttpRequest,
    session: AdminSession,
    cookies: ParsedCookies,
  ): Promise<Record<string, unknown>> {
    await requireCsrf(
      request,
      session,
      sessions,
      cookies[SESSION_COOKIE],
      cookies,
      recordForCsrf(request.body),
      expectedOrigin,
    );
    return requireRecord(request.body);
  }

  async function handleLogin(request: AdminHttpRequest): Promise<AdminHttpResponse> {
    if (request.method === 'GET') {
      const csrf = newCsrfToken();
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Booking Engine admin login</title></head><body><main data-admin-login><h1>Booking Engine admin</h1><form method="post" action="/admin/login"><input type="hidden" name="csrfToken" value="${escapeHtml(csrf)}"><label>Email<input name="email" type="email" maxlength="254" required></label><label>Password<input name="password" type="password" maxlength="256" required></label><button type="submit">Sign in</button></form></main></body></html>`;
      return response(200, html, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'set-cookie': setCsrfCookie(csrf),
      });
    }
    if (request.method !== 'POST') {
      methodNotAllowed();
    }
    await requireCsrf(
      request,
      null,
      sessions,
      undefined,
      parseCookies(headerValue(request.headers, 'cookie')),
      recordForCsrf(request.body),
      expectedOrigin,
    );
    const body = requireRecord(request.body);
    requireAllowedKeys(body, new Set(['csrfToken', 'email', 'password']));
    const user = await authenticateOwner(dependencies.credentials, body['email'], body['password']);
    if (user === null) {
      throw new AdminHttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    const oldToken = parseCookies(headerValue(request.headers, 'cookie'))[SESSION_COOKIE];
    if (oldToken !== undefined) {
      await sessions.destroy(oldToken);
    }
    const ticket = await sessions.create(user);
    return response(
      200,
      { user: serializeUser(ticket.session) },
      {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookies(ticket),
      },
    );
  }

  return {
    async handle(request): Promise<AdminHttpResponse> {
      const method = request.method.toUpperCase();
      const normalizedRequest: AdminHttpRequest = { ...request, method };
      const parsedRoute = parseAdminRoute(request.path);
      if (parsedRoute === undefined) {
        return errorResponse(
          new AdminHttpError(404, 'route_not_found', 'Admin route was not found.'),
        );
      }
      try {
        if (parsedRoute.kind === 'login') {
          return await handleLogin(normalizedRequest);
        }

        const authenticated = await requireSession(sessions, normalizedRequest);
        const { session, token, cookies } = authenticated;

        if (parsedRoute.kind === 'logout') {
          if (method !== 'POST') {
            methodNotAllowed();
          }
          if (request.body !== undefined) {
            const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
            requireNoBodyFields(bodyWithoutCsrf(body));
          } else {
            await requireCsrf(
              normalizedRequest,
              session,
              sessions,
              token,
              cookies,
              undefined,
              expectedOrigin,
            );
          }
          await sessions.destroy(token);
          return response(204, undefined, {
            'set-cookie': [
              clearedCookie(SESSION_COOKIE, secureCookies, true),
              clearedCookie(CSRF_COOKIE, secureCookies, false),
            ],
          });
        }

        if (parsedRoute.kind === 'session') {
          if (method !== 'GET') {
            methodNotAllowed();
          }
          return response(200, { user: serializeUser(session), expiresAt: session.expiresAt });
        }

        if (parsedRoute.kind === 'dashboard') {
          if (method !== 'GET') {
            methodNotAllowed();
          }
          return response(
            200,
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Booking Engine admin</title></head><body><main data-admin-dashboard><h1>Booking Engine admin</h1><p>${escapeHtml(session.email)}</p><p data-admin-role>${escapeHtml(session.role)}</p></main></body></html>`,
            {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy':
                "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
              ...csrfCookieHeaders(session, cookies),
            },
          );
        }

        requirePrivateRead(session);

        if (parsedRoute.kind === 'property') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method !== 'GET') {
            methodNotAllowed();
          }
          if (parsedRoute.page) {
            const csrfToken = session.csrfToken ?? cookies[CSRF_COOKIE];
            if (csrfToken === undefined) {
              throw new AdminHttpError(
                401,
                'invalid_session',
                'A valid admin session is required.',
              );
            }
            const html = renderPage({ property: pageData(property), csrfToken });
            return response(200, html, {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy':
                "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
              ...csrfCookieHeaders(session, cookies),
            });
          }
          return response(200, serializeProperty(property));
        }

        if (parsedRoute.kind === 'content') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method !== 'PUT' && method !== 'POST') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
          const input = validatePropertyUpdate(property, bodyWithoutCsrf(body));
          const updated = await dependencies.properties.update(
            scopeFor(session),
            property.id,
            input,
          );
          if (updated === null) {
            notFound();
          }
          return response(200, serializeProperty(canonicalProperty(updated)));
        }

        if (parsedRoute.kind === 'rates') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method === 'GET') {
            const plan = await dependencies.rates.getRatePlan(scopeFor(session), property.id);
            if (plan === null) {
              notFound();
            }
            return response(200, serializeRatePlan(plan));
          }
          if (method !== 'PUT' && method !== 'POST') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
          const plan = validateRateInput(bodyWithoutCsrf(body));
          const saved = await dependencies.rates.saveRatePlan(scopeFor(session), property.id, plan);
          return response(200, serializeRatePlan(saved));
        }

        if (parsedRoute.kind === 'manualBlocks') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method === 'GET') {
            const blocks = await dependencies.availability.listManualBlocks(
              scopeFor(session),
              property.id,
            );
            if (!Array.isArray(blocks) || blocks.length > MAX_MANUAL_BLOCKS) {
              throw new AdminHttpError(
                500,
                'internal_error',
                'The admin request could not be completed.',
              );
            }
            return response(200, {
              blocks: Object.freeze(
                blocks.map((block) => serializeManualBlock(block, property.id)),
              ),
            });
          }
          if (method !== 'POST') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
          const input = validateManualBlockInput(bodyWithoutCsrf(body));
          const created = await dependencies.availability.createManualBlock(
            scopeFor(session),
            property.id,
            input,
          );
          return response(201, serializeManualBlock(created, property.id));
        }

        if (parsedRoute.kind === 'bookingRequests') {
          if (method !== 'GET') {
            methodNotAllowed();
          }
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (dependencies.bookingRequests.list === undefined) {
            throw new AdminHttpError(
              500,
              'internal_error',
              'The admin request could not be completed.',
            );
          }
          const requests = await dependencies.bookingRequests.list(scopeFor(session), property.id);
          if (!Array.isArray(requests) || requests.length > MAX_MANUAL_BLOCKS) {
            throw new AdminHttpError(
              500,
              'internal_error',
              'The admin request could not be completed.',
            );
          }
          return response(200, {
            requests: Object.freeze(
              requests.map((entry) =>
                serializeBookingRequest(
                  scopedBookingRequest(entry, session, property.id, entry.id),
                ),
              ),
            ),
          });
        }

        if (parsedRoute.kind === 'manualBlock') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          const recordId = validIdentifier(parsedRoute.recordId, 'recordId');
          if (method !== 'DELETE') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body =
            request.body === undefined
              ? undefined
              : await requireCsrfThenRecord(normalizedRequest, session, cookies);
          if (body !== undefined) {
            requireNoBodyFields(bodyWithoutCsrf(body));
          } else {
            await requireCsrf(
              normalizedRequest,
              session,
              sessions,
              token,
              cookies,
              undefined,
              expectedOrigin,
            );
          }
          const released = await dependencies.availability.releaseManualBlock(
            scopeFor(session),
            property.id,
            recordId,
          );
          if (!released) {
            notFound();
          }
          return response(204, undefined);
        }

        if (parsedRoute.kind === 'icalHealth') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          const sourceId = validIdentifier(parsedRoute.sourceId, 'sourceId');
          if (method !== 'GET') {
            methodNotAllowed();
          }
          const result = await dependencies.ical.health(
            Object.freeze({ organizationId: session.organizationId, propertyId: property.id }),
            sourceId,
          );
          return response(200, serializeHealth(sourceId, result));
        }

        if (parsedRoute.kind === 'bookingRequest') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          const requestId = validIdentifier(parsedRoute.requestId, 'requestId');
          if (parsedRoute.action === 'get') {
            if (method !== 'GET') {
              methodNotAllowed();
            }
            const found = await dependencies.bookingRequests.find(
              scopeFor(session),
              property.id,
              requestId,
            );
            return response(
              200,
              serializeBookingRequest(scopedBookingRequest(found, session, property.id, requestId)),
            );
          }
          if (method !== 'POST') {
            methodNotAllowed();
          }
          requireBookingMutation(session);
          const body =
            request.body === undefined
              ? undefined
              : await requireCsrfThenRecord(normalizedRequest, session, cookies);
          if (body !== undefined) {
            requireNoBodyFields(bodyWithoutCsrf(body));
          } else {
            await requireCsrf(
              normalizedRequest,
              session,
              sessions,
              token,
              cookies,
              undefined,
              expectedOrigin,
            );
          }
          if (parsedRoute.action === 'recheck') {
            const result = await dependencies.bookingRequests.recheckAvailability(
              scopeFor(session),
              property.id,
              requestId,
            );
            if (typeof result.available !== 'boolean') {
              throw new AdminHttpError(
                500,
                'internal_error',
                'The admin request could not be completed.',
              );
            }
            return response(200, {
              request: serializeBookingRequest(
                scopedBookingRequest(result.request, session, property.id, requestId),
              ),
              available: result.available,
            });
          }
          const saved =
            parsedRoute.action === 'approve'
              ? await dependencies.bookingRequests.approve(
                  scopeFor(session),
                  property.id,
                  requestId,
                )
              : await dependencies.bookingRequests.reject(
                  scopeFor(session),
                  property.id,
                  requestId,
                );
          return response(
            200,
            serializeBookingRequest(scopedBookingRequest(saved, session, property.id, requestId)),
          );
        }

        return errorResponse(
          new AdminHttpError(404, 'route_not_found', 'Admin route was not found.'),
        );
      } catch (error) {
        return errorResponse(error instanceof AdminHttpError ? error : mapPersistenceError(error));
      }
    },
  };
}

export type {
  AdminHttpApi,
  AdminCredentialRecord,
  AdminHttpApiDependencies,
  AdminHttpApiOptions,
  AdminHttpRequest,
  AdminHttpResponse,
  AdminICalHealthPort,
  AdminPageProperty,
  AdminRole,
  ICalSyncHealth,
  ICalSyncRunResult,
} from './contracts.js';
export { AdminHttpError } from './contracts.js';
export {
  CSRF_COOKIE as ADMIN_CSRF_COOKIE,
  SESSION_COOKIE as ADMIN_SESSION_COOKIE,
} from './security.js';
