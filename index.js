const fs = require('fs') // tmp

const dotenv = require('dotenv')
const fetch = require('isomorphic-unfetch')
const WPAPI = require('wpapi')
const isEqual = require('lodash.isequal')
const Turndown = require('turndown')

const modDate = require('./src/modDate')
const modAuthors = require('./src/modAuthors')
const modCats = require('./src/modCategories')
const modContent = require('./src/modContent')

const turndown = new Turndown({ linkStyle: 'referenced' })

dotenv.config()
const username = process.env.CMS_USER
const password = process.env.CMS_PASSWORD
const cmsUrl = process.env.CMS_URL
const refreshTimer = process.env.REFRESH_TIMER
const dbCtrlUrl = process.env.DB_CTRL_URL

let pulls = []
let pushes = []

const modifyPost = async (wp, p, cats, wpTags) => {
  const date = modDate(p.date, p.acf.imt_date)
  const authors = await modAuthors(p.id, p.acf.imt_author)

  // excerpt
  let excerpt =
    p.acf.imt_excerpt !== undefined && p.acf.imt_excerpt.length > 0
      ? p.acf.imt_excerpt
      : turndown.turndown(p.excerpt.rendered)
  // remove excerpt images
  const mdImgReg = /\!\[(.*?)\]\(.*?\)/g // matches ![](https://link/img.jpg)
  let excerptTexts = []
  excerpt.split(mdImgReg).forEach(t => {
    if (t !== '') excerptTexts.push(t)
  })
  excerpt = excerptTexts.join(' ').trim()

  let result = {
    id: p.id,
    isSticky: p.sticky,
    slug: p.slug,
    status: p.status,
    categories: [],
    title: turndown.turndown(p.title.rendered),
    date,
    modified: new Date(p.modified).getTime(),
    authors,
    excerpt,
    media: '',
    content: '',
    tags: [],
    order: 99,
  }

  // categories
  p.categories.forEach(catId => {
    const cat = cats.find(d => d.id == catId)
    if (cat !== undefined) {
      result.categories.push(cat)
      if (
        cat.parent !== 0 &&
        result.categories.findIndex(d => d.id === cat.parent) == -1
      ) {
        // has a parent and parent hasn't already been added
        const parent = cats.find(d => d.id == cat.parent)
        if (parent !== undefined) {
          result.categories.push(parent)
        } else console.log(`> parent of ${cat.id}, '${cat.name}', not found`)
      }
    }
  })

  // content
  result.content = await modContent(p.content.rendered, wp)

  // featured media
  let mediaUrl = '/static/imt-wil-logo.jpg'
  if (p.featured_media > 0) {
    const m = await wp.media().id(p.featured_media)
    mediaUrl = m.source_url
  } else {
    // featured_media not set, pull first img from post content
    let newContent = []
    let mediaFound = false
    result.content.forEach(d => {
      if (d.key === 'img' && !mediaFound) {
        mediaUrl = d.val
        mediaFound = true
      } else {
        newContent.push(d)
      }
    })
    result.content = newContent
  }
  result.media = mediaUrl

  // tags
  let promises = p.tags.map(async id => {
    let found = false
    wpTags.forEach(wpTag => {
      if (id === wpTag.id) {
        result.tags.push(wpTag.name)
        found = true
      }
    })
    if (!found) {
      //console.debug(`> ${id} not found, retrieving from wordpress`)
      let wpTag = await wp.tags().id(id)
      wpTags.push(wpTag)
      result.tags.push(wpTag.name)
    }
  })
  await Promise.all(promises)

  return result
}

const refresh = async () => {
  // find date of latest updates in dbCtrl
  let dbPostModDate = 0
  let dbEmpty = false
  const r = await fetch(`${dbCtrlUrl}/latest`)
  const dbMods = await r.json()
  if (dbMods.posts.modified !== undefined) {
    console.log(`> latest db post: ${dbMods.posts.modified}`)
    dbPostModDate = new Date(dbMods.posts.modified).getTime()
  } else {
    console.log(`> db has no posts`)
    dbEmpty = true
  }

  // setup wordpress connection
  const wp = await WPAPI.discover(cmsUrl)
  wp.auth({ username, password, auth: true })

  // get cats
  const wpCats = await wp.categories().perPage(100)
  const cats = modCats(wpCats)
  if (!isEqual(modCats(dbMods.cats), cats)) {
    // categories are always updated since wordpress doesn't report when they are modified
    console.log('> sending category updates to dbCtrl...')
    const updatesRes = await fetch(`${dbCtrlUrl}/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'cats', element: cats }),
    })
    if (updatesRes.ok) console.log(`> categories updated successfully`)
    else {
      console.error('> categories update failed')
      console.error(updatesRes)
    }
  } else console.log('> categories update not needed')

  let wpTags = [] // holds all tags (populated when tags within a post are detected)
  let moreMods = true // get next latest cms modification

  let posts

  if (parseInt(process.env.IS_LOCAL) === 1) {
    const pStr = fs.readFileSync(
      '/Users/joshua/projects/imt/socrev-cms/tmp/wpPosts.json'
    )
    posts = JSON.parse(pStr)
    console.log(`> fake wordpress posts length ${posts.length}`)
  }

  const handlePostRefresh = async page => {
    // first pass should be ordered by id asc to ensure all are processed
    // subsequent passes should be ordered by modified
    // the best case is order by modified, ascending, and filtered on modified later than latest in db
    // but wordpress doesn't support queries that filter on the modified date
    // https://stackoverflow.com/q/47053462/2316606
    // next best option is order by modified, descending
    // this means we may miss updates that come in while processing updates until next refresh
    let modPosts

    if (parseInt(process.env.IS_LOCAL) === 1) {
      // use fake posts if we we are testing locally
      modPosts = [...posts]
      modPosts = [modPosts[page - 1]]
      modPosts._paging = { links: {} }
      // add fake paging to continue loop
      if (page !== posts.length) modPosts._paging.links.next = 'exists'
    } else
      modPosts = await wp
        .posts()
        .status(['trash', 'draft', 'future', 'publish'])
        .orderby(`${dbEmpty ? 'id' : 'modified'}`)
        .order(`${dbEmpty ? 'asc' : 'desc'}`)
        .page(page)
        .perPage(1)
    /*
      .id(4232)
      .before(new Date('2017-08-16'))
      .after(new Date('2017-08-14'))
    */
    let p = Array.isArray(modPosts) ? modPosts[0] : modPosts // p is not array if request an id

    // add unique ids for each post we pull from wordpress (for logging only)
    if (!pulls.includes(p.id)) pulls.push(p.id)

    let cmsPostModDate = new Date(p.modified).getTime()
    console.log(
      `> ${`${p.id}`.padStart(4)} | ${p.title.rendered} | ${p.modified}`
    )
    console.log(
      `> comparing ${new Date(p.modified)} to ${new Date(dbPostModDate)}`
    )
    if (cmsPostModDate > dbPostModDate) {
      // this cms modification is more recent than db
      console.log(
        `> post ${new Date(p.modified)} more recent than db ${new Date(
          dbPostModDate
        )}`
      )
      p = await modifyPost(wp, p, cats, wpTags)
      //console.log('> sending post to dbCtrl...')
      //console.log(body.length) // push to express endpoint can fail if post body is too big

      if (parseInt(process.env.IS_LOCAL) === 0) {
        // only post to database if we are not running a local test
        const updatesRes = await fetch(`${dbCtrlUrl}/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'posts',
            element: p,
          }),
        })
        if (updatesRes.ok) {
          //console.log(`> post update (or create) succeeded`)
          if (!pushes.includes(p.id)) pushes.push(p.id) // only add pushes once
        } else {
          console.error('> failed to post update to socrev-db')
          console.error(updatesRes)
        }
      }
    } else {
      //if (modPosts._paging.links.next === undefined) {
      console.log(`> db in sync, refresh in ${refreshTimer / 1000 / 60}mins`)
      moreMods = false
      /*
      const pullsFileUrl = '/Users/joshua/projects/imt/pulls.json'
      const pushesFileUrl = '/Users/joshua/projects/imt/pushes.json'
      fs.writeFileSync(pullsFileUrl, JSON.stringify(pulls))
      fs.writeFileSync(pushesFileUrl, JSON.stringify(pushes))
      */
      console.log(`> unique pulls=>pushes: ${pulls.length}=>${pushes.length}`)
      /*
      if (pulls.length !== pushes.length) {
        console.error(
          `> number of pulls from wordpress do not match the number of pushes to mongo!`
        )
        const pushDiffs = pushes.filter(push => !pulls.includes(push))
        const pullDiffs = pulls.filter(pull => !pushes.includes(pull))
        if (pushDiffs.length > 0)
          console.error(`pushes not in pull:\n${pushDiffs}`)
        if (pullDiffs.length > 0)
          console.error(`pulls not in push:\n${pullDiffs}`)
      }
      */
    }
  }

  // loop to pull a post while there are more updates
  for (let i = 1; moreMods; i++) {
    await handlePostRefresh(i)
  }
}

const main = async () => {
  try {
    await refresh()
  } catch (e) {
    if (e.name === 'FetchError') {
      console.error(`> failed connecting to ${dbCtrlUrl} (will retry later)`)
    } else {
      console.error('> failed on initial refresh. message from wordpress:')
    }
    console.error(e)
  }
  setInterval(async () => {
    console.log('refreshing...')
    try {
      await refresh()
    } catch (e) {
      if (e.name === 'FetchError') {
        console.error(`> failed connecting to ${dbCtrlUrl} (will retry later)`)
      } else {
        console.error('> failed on subsequent refresh. message from wordpress:')
      }
      console.error(e)
    }
    console.log(`> db in sync, refresh in ${refreshTimer / 1000 / 60}mins`)
  }, refreshTimer)
}

main()
