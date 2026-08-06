const EMAIL_FROM = process.env.EMAIL_FROM || "DentalCare <no-reply@dentalcare.app>";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export function getResetLink(token: string): string {
  return `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

export function getVerifyLink(token: string): string {
  return `${APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
}

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.EMAIL_RESEND_API_KEY;

  if (!apiKey) {
    console.log("==========================================");
    console.log(`[EMAIL] To: ${to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log("[EMAIL] Body:");
    console.log(html);
    console.log("==========================================");
    return;
  }

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to,
        subject,
        html,
      }),
    });
  } catch (error) {
    console.error("[EMAIL] Failed to send email via Resend", error);
  }
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Réinitialisation de votre mot de passe",
    html: `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 22px; font-weight: 700; color: #1e2a5a; margin: 0 0 16px;">DentalCare</h1>
        <p style="color: #3f424e; line-height: 1.6;">Bonjour,</p>
        <p style="color: #3f424e; line-height: 1.6;">
          Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.
        </p>
        <p style="text-align: center; margin: 24px 0;">
          <a href="${resetUrl}" style="display: inline-block; background-color: #1e2a5a; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
            Réinitialiser mon mot de passe
          </a>
        </p>
        <p style="color: #858b9e; font-size: 14px; line-height: 1.5;">
          Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email.
        </p>
      </div>
    `,
  });
}

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Vérifiez votre adresse email",
    html: `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 22px; font-weight: 700; color: #1e2a5a; margin: 0 0 16px;">DentalCare</h1>
        <p style="color: #3f424e; line-height: 1.6;">Bonjour,</p>
        <p style="color: #3f424e; line-height: 1.6;">
          Merci de vous être inscrit sur DentalCare. Cliquez sur le bouton ci-dessous pour vérifier votre adresse email.
        </p>
        <p style="text-align: center; margin: 24px 0;">
          <a href="${verifyUrl}" style="display: inline-block; background-color: #1e2a5a; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
            Vérifier mon email
          </a>
        </p>
        <p style="color: #858b9e; font-size: 14px; line-height: 1.5;">
          Ce lien est valable 1 heure.
        </p>
      </div>
    `,
  });
}
