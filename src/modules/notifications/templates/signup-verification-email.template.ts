export type SignupVerificationEmailContent = {
  subject: string;
  html: string;
  text: string;
};

type BuildSignupVerificationEmailArgs = {
  code: string;
  verifyUrl: string;
  expiryMinutes: number;
};

function codeDigits(code: string): string[] {
  return code.padStart(8, '0').slice(0, 8).split('');
}

export function buildSignupVerificationEmail(
  args: BuildSignupVerificationEmailArgs,
): SignupVerificationEmailContent {
  const { code, verifyUrl, expiryMinutes } = args;
  const digitRow = codeDigits(code)
    .map(
      (digit) =>
        `<td align="center" style="padding:0 4px;"><div style="width:44px;height:52px;line-height:52px;background-color:#f4f7fb;border:1px solid #d6dce2;border-radius:8px;font-size:22px;font-weight:700;color:#0c2b4e;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${digit}</div></td>`,
    )
    .join('');

  const subject = 'Verify your DocuShield account';

  const text = [
    'DocuShield — Verify your email',
    '',
    'Thanks for signing up. Enter this code to confirm your email and finish creating your account.',
    '',
    `Your verification code: ${code}`,
    '',
    `Open this link to enter your code: ${verifyUrl}`,
    '',
    `This code expires in ${expiryMinutes} minutes.`,
    '',
    'If you did not create an account, you can safely ignore this email.',
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
              <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#0c2b4e;line-height:1.3;">Verify your email</h1>
              <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#5a6b7b;">
                Welcome to DocuShield. Enter the code below to confirm you own this email address and complete your registration.
              </p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto 24px;">
                <tr>${digitRow}</tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td align="center" style="padding:0 0 24px;">
                    <a href="${verifyUrl}" style="display:inline-block;background-color:#0c2b4e;color:#f4f4f4;text-decoration:none;font-size:14px;font-weight:600;padding:14px 28px;border-radius:8px;">Verify email</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f7fb;border-radius:8px;border:1px solid #e4ebf3;">
                <tr>
                  <td style="padding:14px 16px;text-align:center;">
                    <p style="margin:0;font-size:12px;color:#5a6b7b;line-height:1.5;">
                      <strong style="color:#0c2b4e;">Expires in ${expiryMinutes} minutes.</strong><br />
                      For your security, this code is single-use.
                    </p>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#5a6b7b;">
                If you didn&apos;t sign up for DocuShield, you can ignore this email.
              </p>
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
