// Phase 1: Morning Pipeline Coach — weekday 8am Spanish brief per rep.
import { generate } from './client.ts';
import { fetchRepPipeline, fetchUnassignedSummary, type RepPipeline } from './crmData.ts';
import { deliveryJid, loadReps, type Rep } from './reps.ts';

type SendText = (chatJid: string, text: string) => Promise<void>;

const SYSTEM = `Eres el coach de ventas de Akciz (vendemos kits Starlink a empresas en México).
Cada mañana escribes un brief breve de WhatsApp para un vendedor, en español, con tono directo y motivador (nada corporativo, cero relleno).

Formato EXACTO:
☀️ Buenos días {nombre} — tu plan de hoy:

🎯 *Top leads para trabajar hoy* (máx 5, ordenados por potencial)
1. {Empresa} — {por qué hoy, 1 línea: tamaño, dolor, urgencia}
...

✍️ *Mensaje sugerido para el #1:*
"{mensaje de apertura por WhatsApp, 2-3 frases, personalizado al negocio del lead}"

⏰ *Seguimientos vencidos* (si hay)
- {Empresa} — vencía {fecha}: {siguiente paso}

📌 *Deals que necesitan empujón* (si hay)
- {Deal} — {qué hacer}

Reglas: máximo ~25 líneas en total. Usa SOLO los datos proporcionados — no inventes nombres, montos ni contexto. Si una sección no tiene datos, omítela. Si no hay absolutamente nada accionable, escribe un mensaje de 2 líneas reconociéndolo.`;

function briefPrompt(rep: Rep, p: RepPipeline): string {
  return [
    `Vendedor: ${rep.name.split(' ')[0]}`,
    `Fecha: ${new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}`,
    '',
    `LEADS SIN PRÓXIMO PASO (asignados, enfriándose) — ${p.untouched.length}:`,
    JSON.stringify(p.untouched, null, 0),
    '',
    `LEADS CON SEGUIMIENTO HOY O VENCIDO — ${p.dueOrOverdue.length}:`,
    JSON.stringify(p.dueOrOverdue, null, 0),
    '',
    `DEALS ABIERTOS ESTANCADOS (de ${p.openDealCount} abiertos) — ${p.staleDeals.length}:`,
    JSON.stringify(p.staleDeals, null, 0),
  ].join('\n');
}

export interface CoachRunResult {
  briefsSent: number;
  skipped: string[];
  errors: string[];
}

export async function runPipelineCoach(sendText: SendText): Promise<CoachRunResult> {
  const registry = loadReps();
  if (!registry) throw new Error('reps.json not configured');

  const result: CoachRunResult = { briefsSent: 0, skipped: [], errors: [] };
  const statLines: string[] = [];

  for (const rep of registry.reps) {
    if (!rep.crmUserId || rep.crmUserId.startsWith('put-')) {
      result.skipped.push(`${rep.name} (no CRM user id)`);
      continue;
    }
    try {
      const pipeline = await fetchRepPipeline(rep.crmUserId);
      const brief = await generate(SYSTEM, briefPrompt(rep, pipeline));
      const { jid, prefix } = deliveryJid(rep, registry);
      await sendText(jid, prefix + brief);
      result.briefsSent += 1;
      statLines.push(
        `• ${rep.name}: ${pipeline.untouched.length} sin paso · ${pipeline.dueOrOverdue.length} vencidos · ${pipeline.staleDeals.length}/${pipeline.openDealCount} deals estancados`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${rep.name}: ${message}`);
      console.error(`Pipeline coach failed for ${rep.name}:`, message);
    }
  }

  // Routine admin digest is off (Dan's request, 2026-08). He still gets a note
  // when something went wrong, so failures never pass silently. Opt the full
  // digest back in with COACH_ADMIN_DIGEST=1.
  const wantsDigest = process.env.COACH_ADMIN_DIGEST === '1';
  try {
    if (wantsDigest) {
      const pool = await fetchUnassignedSummary();
      const topNames = pool.topUnassigned
        .map((l) => l.company_name)
        .filter(Boolean)
        .slice(0, 3)
        .join(', ');
      const digest = [
        '🧭 *Coach digest*',
        ...statLines,
        `📥 Pool sin asignar: *${pool.totalUnassignedNew}* leads${topNames ? ` — top: ${topNames}` : ''}`,
        ...(result.skipped.length ? [`⚪ Sin configurar: ${result.skipped.join('; ')}`] : []),
        ...(result.errors.length ? [`⚠️ Errores: ${result.errors.join('; ')}`] : []),
      ].join('\n');
      await sendText(registry.admin.jid, digest);
    } else if (result.errors.length > 0) {
      await sendText(
        registry.admin.jid,
        `⚠️ *Coach:* ${result.briefsSent} briefs enviados, ${result.errors.length} con error:\n${result.errors.join('\n')}`,
      );
    }
  } catch (err) {
    console.error('Coach admin digest failed:', err instanceof Error ? err.message : err);
  }

  return result;
}
