import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!existsSync('eval/results/latest.json'))
    return NextResponse.json({ error: 'No evaluation has been run yet. Run `npm run eval`.' }, { status: 404 });
  return NextResponse.json(JSON.parse(readFileSync('eval/results/latest.json', 'utf8')));
}
