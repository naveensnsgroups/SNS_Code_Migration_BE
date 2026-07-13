// GitHub OAuth Device Flow — a backend proxy to GitHub's device endpoints.
// The proxy is required because GitHub's github.com/login/* token endpoints do
// not send CORS headers, so the browser cannot call them directly. Device flow
// (not the redirect flow) is used because this tool runs locally with no public
// callback URL. Only a GitHub OAuth App Client ID is needed — device flow uses
// no client secret.
//
// The Client ID is a platform-level default (GITHUB_OAUTH_CLIENT_ID env var),
// baked in the same way VS Code / GitHub Desktop / the gh CLI each ship with
// their own pre-registered Client ID — end users never see or supply one. A
// request body clientId is still accepted as an explicit override, for a
// self-hosted deployment that wants to use its own OAuth App instead.
import { Router, Request, Response, NextFunction } from 'express';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL       = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL        = 'https://api.github.com/user';

// `repo` grants clone/push on public and private repos (Phase A3); `read:user`
// lets us show the signed-in account. Overridable per-request.
const DEFAULT_SCOPE = 'repo read:user';

function resolveClientId(override?: string): string {
  return (override || process.env.GITHUB_OAUTH_CLIENT_ID || '').trim();
}

const router = Router();

// Step 1 — request a device + user code. The frontend shows the user_code and
// opens verification_uri; the user authorizes there.
router.post('/device', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId: clientIdOverride, scope } = req.body as { clientId?: string; scope?: string };
    const clientId = resolveClientId(clientIdOverride);
    if (!clientId) {
      res.status(400).json({
        error: 'GitHub sign-in is not configured on this server — GITHUB_OAUTH_CLIENT_ID is not set.',
        code: 'NO_CLIENT_ID',
      });
      return;
    }

    const ghRes = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: scope || DEFAULT_SCOPE }),
    });
    const data = await ghRes.json() as Record<string, unknown>;

    if (!ghRes.ok || data.error) {
      res.status(400).json({
        error: (data.error_description as string) || (data.error as string) || 'GitHub device-code request failed.',
        code: 'DEVICE_CODE_FAILED',
      });
      return;
    }

    res.json({
      deviceCode:      data.device_code,
      userCode:        data.user_code,
      verificationUri: data.verification_uri,
      expiresIn:       data.expires_in,
      interval:        data.interval,
    });
  } catch (err) {
    next(err);
  }
});

// Step 2 — poll for the token. Called repeatedly by the frontend at the given
// interval. Returns a discrete status so the frontend never has to parse
// GitHub's raw error strings.
router.post('/poll', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId: clientIdOverride, deviceCode } = req.body as { clientId?: string; deviceCode?: string };
    const clientId = resolveClientId(clientIdOverride);
    if (!clientId || !deviceCode) {
      res.status(400).json({ error: 'Missing clientId or deviceCode.', code: 'BAD_REQUEST' });
      return;
    }

    const ghRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:   clientId,
        device_code: deviceCode,
        grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await ghRes.json() as Record<string, unknown>;

    // Still waiting on the user, or GitHub asked us to back off.
    if (data.error === 'authorization_pending') { res.json({ status: 'pending' }); return; }
    if (data.error === 'slow_down')             { res.json({ status: 'slow_down', interval: data.interval }); return; }
    if (data.error === 'expired_token')         { res.json({ status: 'expired' }); return; }
    if (data.error === 'access_denied')         { res.json({ status: 'denied' }); return; }
    if (data.error) {
      res.json({ status: 'error', error: (data.error_description as string) || (data.error as string) });
      return;
    }

    const accessToken = data.access_token as string | undefined;
    if (!accessToken) { res.json({ status: 'pending' }); return; }

    // Authorized — fetch the account so the frontend can show it. A User-Agent
    // header is mandatory for the GitHub REST API.
    const userRes = await fetch(GITHUB_USER_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'code-migration-platform',
      },
    });
    const user = await userRes.json() as Record<string, unknown>;

    res.json({
      status: 'authorized',
      accessToken,
      user: {
        login: user.login,
        name:  user.name,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
