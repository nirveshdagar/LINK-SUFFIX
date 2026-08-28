import { City, State } from 'country-state-city'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const country = (url.searchParams.get('country') ?? '').toUpperCase()
  const state = (url.searchParams.get('state') ?? '').toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) return NextResponse.json({ error: 'Valid country code required' }, { status: 400 })

  if (state) {
    const cities = City.getCitiesOfState(country, state)
      .map(city => city.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
    return NextResponse.json({ cities })
  }

  const states = State.getStatesOfCountry(country)
    .map(item => ({ code: item.isoCode, name: item.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return NextResponse.json({ states })
}
