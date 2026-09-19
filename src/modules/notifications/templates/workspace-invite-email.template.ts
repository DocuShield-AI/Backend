export type WorkspaceInviteEmailContent = {
  subject: string;
  html: string;
  text: string;
};

type BuildWorkspaceInviteEmailArgs = {
  workspaceName: string;
  inviteCode: string;
  role: string;
  joinUrl: string;
  expiresAt: Date;
  inviterEmail?: string;
};

function formatRole(role: string): string {
  const labels: Record<string, string> = {
    admin: 'Admin',
    legal: 'Legal',
    viewer: 'Viewer',
  };
  return labels[role] ?? role;
}

function formatExpiry(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function buildWorkspaceInviteEmail(
  args: BuildWorkspaceInviteEmailArgs,
): WorkspaceInviteEmailContent {
  const { workspaceName, inviteCode, role, joinUrl, expiresAt, inviterEmail } = args;
  const roleLabel = formatRole(role);
  const expiryLabel = formatExpiry(expiresAt);
  const inviterLine = inviterEmail
    ? `${inviterEmail} has invited you to join`
    : 'You have been invited to join';

  const subject = `You're invited to ${workspaceName} on DocuShield`;

  const text = [
    'DocuShield — Workspace invitation',
    '',
    `${inviterLine} ${workspaceName} on DocuShield.`,
    '',
    `Your role: ${roleLabel}`,
    `Invite code: ${inviteCode}`,
    '',
    `Join your team: ${joinUrl}`,
    '',
    `This invitation expires on ${expiryLabel}.`,
    '',
    '— DocuShield',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f1eb;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f1eb;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background-color:#ffffff;border-radius:12px;border:1px solid #e4ebf3;overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(165deg,#0c2b4e 0%,#1a3d64 55%,#1d546c 100%);padding:28px 32px;text-align:center;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#f4f4f4;letter-spacing:-0.02em;">DocuShield</p>
              <p style="margin:8px 0 0;font-size:13px;color:rgba(244,244,244,0.75);">Secure contract risk triage</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 24px;">
              <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#0c2b4e;line-height:1.3;">You&apos;re invited</h1>
              <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#5a6b7b;">
                ${inviterLine} <strong style="color:#0c2b4e;">${workspaceName}</strong>. Create your account to start triaging contracts with your team.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f7fb;border-radius:8px;border:1px solid #e4ebf3;margin-bottom:24px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0 0 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#5a6b7b;">Invite code</p>
                    <p style="margin:0;font-size:24px;font-weight:700;letter-spacing:0.12em;color:#0c2b4e;font-family:monospace;">${inviteCode}</p>
                    <p style="margin:12px 0 0;font-size:12px;color:#5a6b7b;">Your role: <strong style="color:#0c2b4e;">${roleLabel}</strong></p>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td align="center" style="padding:0 0 24px;">
                    <a href="${joinUrl}" style="display:inline-block;background-color:#0c2b4e;color:#f4f4f4;text-decoration:none;font-size:14px;font-weight:600;padding:14px 28px;border-radius:8px;">Join workspace</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f7fb;border-radius:8px;border:1px solid #e4ebf3;">
                <tr>
                  <td style="padding:14px 16px;text-align:center;">
                    <p style="margin:0;font-size:12px;color:#5a6b7b;line-height:1.5;">
                      <strong style="color:#0c2b4e;">Expires ${expiryLabel}.</strong><br />
                      This invite is single-use.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 28px;border-top:1px solid #e4ebf3;text-align:center;">
              <p style="margin:0;font-size:11px;color:#5a6b7b;line-height:1.5;">
                &copy; ${new Date().getFullYear()} DocuShield. All rights reserved.<br />
                This is an automated message — please do not reply.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}
