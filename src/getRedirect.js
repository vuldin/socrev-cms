const fetch = require('isomorphic-unfetch')
const dotenv = require('dotenv')

dotenv.config()
const dbAppUrl = process.env.DB_CTRL_URL

module.exports = async body => {
  // returns an old article's slug for a given oldId or newID request
  let result = {}
  body = JSON.stringify(body)
  const response = await fetch(`${dbAppUrl}/fromid`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  const json = await response.json() // { old, new, author, slug }
  if (response.status !== 200) {
    console.log(`> unable to retrieve redirect details`)
    console.log(response)
    return result
  }
  if (json === null) {
    console.log(`> redirect details not found for ${body}`)
  } else result = json
  return result
}
