const app = require('express')()
const http = require('http').Server(app)
const bodyParser = require('body-parser')
let io = require('socket.io')
const cors = require('cors')
const dotenv = require('dotenv')
const fs = require('fs')
const fetch = require('isomorphic-unfetch')
const WPAPI = require('wpapi')
const DOMParser = require('xmldom').DOMParser
const isEqual = require('lodash.isequal')
const postMod = require('./src/postMod')

dotenv.config()

const port = process.env.PORT
const cmsUser = process.env.CMS_USER
const cmsPass = process.env.CMS_PASSWORD
const cmsUrl = process.env.CMS_URL
const refreshTimer = process.env.REFRESH_TIMER
const dbCtrlUrl = process.env.DB_CTRL_URL

app.use(cors())
app.use(bodyParser.json())

const modifyPost = async (wp, p, cats) => {
  p = await postMod.getFeatureSrc(p, wp)
  p = await postMod.modCategories(p, cats)
  //p = await postMod.modHeading(p)
  p = await postMod.modFigure(p)
  //p = await postMod.imgToFigure(p)
  p = await postMod.handleNoFeature(p)
  p = await postMod.removeRepeatImage(p)
  p = await postMod.removeExcerptImage(p)
  p = await postMod.removeExcerptMarkup(p)
  return p
}

const modifyCats = cats => {
  // create webapp-ready categories from wordpress categories
  const decodeString = string => {
    const dom = new DOMParser().parseFromString(
      `<body>${string}</body>`,
      'text/html'
    )
    return dom.documentElement.firstChild.nodeValue
  }
  let parents = []
  let subs = []
  cats.forEach(c => {
    let result = {
      name: decodeString(c.name),
      id: c.id,
      parent: c.parent,
      slug: c.slug,
    }
    if (c.parent === 0) parents.push(result)
    else subs.push(result)
  })
  parents.filter(p => p.name !== 'Uncategorized').forEach(p => {
    p.children = subs.filter(s => s.parent === p.id)
  })
  return parents
}

const shouldCatsUpdate = (dbCats, cmsCats) => {
  // returns true if db and cms copy of categories is different
  const sort = (a, b) => a.id - b.id
  const cleanCat = d => {
    let result = {
      name: d.name,
      id: d.id,
      parent: d.parent,
      slug: d.slug,
    }
    if (d.children) {
      d.children = d.children.sort(sort)
      result.children = d.children
    }
    return result
  }
  dbCats = dbCats.map(cleanCat)
  cmsCats = cmsCats.map(cleanCat)
  dbCats.sort(sort)
  cmsCats.sort(sort)
  return !isEqual(dbCats, cmsCats)
}

const refresh = async () => {
  // get latest updates from dbCtrl
  const r = await fetch(`${dbCtrlUrl}/latest`)
  const dbMods = await r.json()
  console.log(`latest db post: ${dbMods.posts.modified}`)
  const dbPostModDate = new Date(dbMods.posts.modified).getTime()

  // setup wordpress connection
  const wp = await WPAPI.discover(cmsUrl)
  wp.auth({
    username: cmsUser,
    password: cmsPass,
    auth: true,
  })

  // handle categories
  const origCats = await wp.categories().perPage(100)
  const cats = modifyCats(origCats)
  if (shouldCatsUpdate(dbMods.cats, cats)) {
    console.log('sending category updates to dbCtrl...')
    const updatesRes = await fetch(`${dbCtrlUrl}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cats',
        element: cats,
      }),
    })
    if (updatesRes.ok) console.log(`categories updated successfully`)
    else console.log(updatesRes)
  }

  // handle posts
  let moreMods = true // get next latest cms modification

  const handlePostRefresh = async page => {
    console.log('getting next latest post...')
    const modPosts = await wp
      .posts()
      .status(['draft', 'future', 'publish'])
      .orderby('modified')
      .page(page)
      .perPage(1)
    let p = modPosts[0]
    console.log(`${p.slug}: ${p.modified}...`)
    let cmsPostModDate = new Date(p.modified).getTime()
    if (cmsPostModDate > dbPostModDate) {
      // this cms modification is more recent than db
      console.log(`... is more recent than anything in db `)
      console.log(`modifying post for webapp`)
      p = await modifyPost(wp, p, cats)
      console.log('sending post to dbCtrl...')
      const updatesRes = await fetch(`${dbCtrlUrl}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'posts',
          element: p,
        }),
      })
      if (updatesRes.ok) console.log(`post update (or create) succeeded`)
      else console.log(updatesRes)
    } else {
      console.log(`db is in sync with cms`)
      moreMods = false
    }
  }
  for (let i = 1; moreMods; i++) {
    await handlePostRefresh(i)
  }
}

const main = async () => {
  try {
    await refresh()
  } catch (e) {
    if (e.name === 'FetchError')
      console.log(`failed connecting to ${dbCtrlUrl}`)
    console.log(e)
  }
  setInterval(async () => {
    console.log('refreshing...')
    try {
      await refresh()
    } catch (e) {
      if (e.name === 'FetchError')
        console.log(`failed connecting to ${dbCtrlUrl}`)
      else console.log(e)
    }
    console.log(`next refresh in ${refreshTimer}ms`)
  }, refreshTimer)
}
main()
