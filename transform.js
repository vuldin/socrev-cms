const dotenv = require('dotenv')
const fs = require('fs')
const fetch = require('isomorphic-unfetch')
const WPAPI = require('wpapi')
const DOMParser = require('xmldom').DOMParser
const isEqual = require('lodash.isequal')
const Turndown = require('turndown')
const marked = require('marked')
const flatten = require('lodash.flatten')

const turndown = new Turndown({
  linkStyle: 'referenced',
})
dotenv.config()

const cmsUser = process.env.CMS_USER
const cmsPass = process.env.CMS_PASSWORD
const cmsUrl = process.env.CMS_URL
const refreshTimer = process.env.REFRESH_TIMER
const dbCtrlUrl = process.env.DB_CTRL_URL

const modifyPost = async (wp, p, cats, wpTags) => {
  const markupToMarkdown = str => {
    return turndown.turndown(str)
  }
  const getLex = md => {
    return marked.lexer(md)
  }

  // date
  let date = new Date(p.date).getTime()
  if (p.acf.imt_date !== undefined && p.acf.imt_date.length > 0) {
    let imtDate = p.acf.imt_date
    date = new Date(
      imtDate.substring(0, 4),
      imtDate.substring(4, 6),
      imtDate.substring(6, 8)
    ).getTime()
  }

  // author
  let authors = ['IMT member']
  if (p.acf.imt_author !== undefined && p.acf.imt_author.length > 0) {
    if (Array.isArray(p.acf.imt_author)) {
      // is a populated array
      authors = p.acf.imt_author
    }
    if (typeof p.acf.imt_author === 'string') {
      // is a string longer than nothing
      authors = [p.acf.imt_author]
    }
  }

  let result = {
    id: p.id,
    isSticky: p.sticky,
    slug: p.slug,
    status: p.status,
    categories: [],
    title: markupToMarkdown(p.title.rendered),
    date,
    modified: new Date(p.modified).getTime(),
    authors,
    excerpt:
      p.acf.imt_excerpt.length > 0
        ? p.acf.imt_excerpt
        : markupToMarkdown(p.excerpt.rendered),
    media: '',
    content: '',
    tags: [],
  }

  // add categories given category ids
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

  // remove any links from excerpt
  const mdImgReg = /\!\[(.*?)\]\(.*?\)/g // matches ![](https://link/img.jpg)
  result.excerpt.split(mdImgReg).forEach(t => {
    if (t !== '') result.excerpt = t
  })

  // content
  const markdown = markupToMarkdown(p.content.rendered)
  const lex = getLex(markdown)
  let newLex = []

  let bqCount = 0 // updated on blockquote_start and blockquote_end
  let bqText = '' // blockquote text

  const handleLinks = txt => {
    // link handling
    const refReg = /\[\d{1,2}\]/g // match 1 or 2 length ref links
    let refLinks = txt.match(refReg)
    //console.log(refLinks)
    if (refLinks !== null) {
      txt += `\n`
      refLinks.forEach(refLink => {
        let ref = refLink.replace('[', '')
        ref = ref.replace(']', '')
        txt += `\n${refLink}: ${lex.links[ref].href}`
      })
    }
    return txt
  }

  lex.forEach(d => {
    switch (d.type) {
      case 'paragraph':
        let texts = [] // array of texts for this entry
        /*
        if (bqCount > 0) {
          // append to the ongoing blockquote
          bqText += `${bqText.length > 0 ? '\n' : ''}${'> '.repeat(bqCount)}${
            d.text
          }`
        }
        */

        // img handling
        const mdImgReg = /\!\[(.*?)\]\(.*?\)/g // matches ![](https://link/img.jpg)
        const imgs = d.text.match(mdImgReg) // array of imgs in this entry
        d.text.split(mdImgReg).forEach(t => {
          // grab the rest of the text from a paragraph containing an image
          if (t !== '') {
            texts.push(t)
          }
        })
        if (imgs !== null && imgs.length > -1) {
          if (imgs.length > 1) console.log(`> ${imgs.length} imgs in paragraph`)
          // grab img link from markdown
          const linkReg = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/
          // insert img entry
          imgs.forEach(img => {
            const linkMatch = img.match(linkReg)
            if (linkMatch !== null) {
              newLex.push({
                key: 'img',
                val: linkMatch[0],
              })
            }
          })
        }

        // text handling
        texts.forEach((t, i) => {
          if (t.length > 0) {
            let val = t.trim()
            val = handleLinks(val)
            if (bqCount > 0) {
              // append to the ongoing blockquote
              bqText += `${bqText.length > 0 ? '\n' : ''}${'> '.repeat(
                bqCount
              )}${val}`
            } else {
              const sentenceReg = /[^\.!\?]+[\.!\?]+/g // matches 'this is a sentence.'
              if (val.match(sentenceReg) === null) {
                // val is not a sentence, add as c entry
                const result = { key: 'c', val }
                newLex.push(result)
              } else {
                // add as p entry
                newLex.push({ key: 'p', val })
              }
            }
          }
        })
        break

      case 'heading':
        // TODO handle removing * from: **Affordable housing and the “poor door”**
        newLex.push({ key: 'h', val: d.text })
        if (bqCount > 0)
          bqText += `${bqText.length > 0 ? '\n' : ''}${'> '.repeat(bqCount)}${
            d.text
          }`
        break

      case 'blockquote_start':
        bqCount += 1 // increment blockquote depth
        break

      case 'blockquote_end':
        bqCount -= 1
        if (bqCount === 0) {
          const val = handleLinks(bqText)
          const result = { key: 'p', val }
          newLex.push(result)
          bqText = ''
        }
        break

      default:
        console.log('> unhandled type')
        console.log(d)
    }
  })
  //console.log(newLex)
  result.content = newLex

  // media
  let mediaUrl = '/static/imt-wil-logo.jpg'
  if (p.featured_media > 0) {
    const m = await wp.media().id(p.featured_media)
    mediaUrl = m.source_url
  } else {
    // featured_media not set, pull from post content
    // go through markdown
    // grab first mediaUrl
    // create new content array with all but the pulled media
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
      console.debug(`> ${id} not found, retrieving from wordpress`)
      let wpTag = await wp.tags().id(id)
      wpTags.push(wpTag)
      result.tags.push(wpTag.name)
    }
  })
  await Promise.all(promises)

  return result
}

const modifyCats = cats => {
  // create flat array of categories from wordpress categories
  const decodeString = string => {
    const dom = new DOMParser().parseFromString(
      `<body>${string}</body>`,
      'text/html'
    )
    return dom.documentElement.firstChild.nodeValue
  }
  let newCats = []
  cats.forEach(c => {
    let result = {
      name: decodeString(c.name),
      id: c.id,
      parent: c.parent,
      slug: c.slug,
    }
    newCats.push(result)
  })

  // cleanup
  newCats = newCats
    .filter(p => p.name !== 'Uncategorized')
    .sort((a, b) => a.id - b.id)

  return newCats
}

const refresh = async () => {
  // get latest updates from dbCtrl
  const r = await fetch(`${dbCtrlUrl}/latest`)
  const dbMods = await r.json()
  let dbPostModDate = 0
  if (dbMods.posts.modified !== undefined) {
    console.log(`> latest db post: ${dbMods.posts.modified}`)
    dbPostModDate = new Date(dbMods.posts.modified).getTime()
  } else {
    console.log(`> db has no posts`)
  }

  // TODO in order to pull recent updates regardless of mongo latest update
  //dbPostModDate = new Date('2018-02-20').getTime()
  //dbPostModDate = 1520456314999

  console.log(`> dbPostModDate: ${dbPostModDate}`)

  // setup wordpress connection
  const wp = await WPAPI.discover(cmsUrl)
  wp.auth({
    username: cmsUser,
    password: cmsPass,
    auth: true,
  })

  // get cats
  const wpCats = await wp.categories().perPage(100)
  const cats = modifyCats(wpCats)
  // should mongo categories be updated?
  if (!isEqual(modifyCats(dbMods.cats), cats)) {
    console.log('> sending category updates to dbCtrl...')
    const updatesRes = await fetch(`${dbCtrlUrl}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cats',
        element: cats,
      }),
    })
    if (updatesRes.ok) console.log(`> categories updated successfully`)
    else console.log(updatesRes)
  } else console.log('> categories update not needed')

  let wpTags = []

  /*
  // get tags
  // tags are pulled from wordpress before handling posts
  // the tag collection expands as/if new tags are found in posts
  const getAll = request => {
    // handle wordpress pagination
    return request.then(function(response) {
      if (!response._paging || !response._paging.next) {
        return response
      }
      // Request the next page and return both responses as one collection
      return Promise.all([response, getAll(response._paging.next)]).then(
        function(responses) {
          return flatten(responses)
        }
      )
    })
  }
  console.log('> getting tags...')
  wpTags = await getAll(wp.tags())
  console.log(`> ${wpTags.length} tags retrieved`)
  */

  // handle posts
  //let count = 1 // number of posts to mod
  //let posts = []
  let moreMods = true // get next latest cms modification

  // TODO this must retrieve all posts, including deleted
  const handlePostRefresh = async page => {
    console.log('> getting next latest post...')
    const modPosts = await wp
      .posts()
      .status(['draft', 'future', 'publish'])
      .orderby('modified')
      .page(page)
      .perPage(1)
    let p = modPosts[0]
    let cmsPostModDate = new Date(p.modified).getTime()
    console.log(`> ${p.title.rendered}`)
    console.log(`> ${p.slug}: ${cmsPostModDate}...`)
    if (cmsPostModDate > dbPostModDate) {
      // this cms modification is more recent than db
      console.log(`> ...is more recent than latest in db ${dbPostModDate}`)
      //console.log(`modifying post for webapp`)
      p = await modifyPost(wp, p, cats, wpTags)
      console.log('> sending post to dbCtrl...')
      const updatesRes = await fetch(`${dbCtrlUrl}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'posts',
          element: p,
        }),
      })
      if (updatesRes.ok) console.log(`> post update (or create) succeeded`)
      else console.log(updatesRes)
    } else {
      console.log(`> db is in sync with cms`)
      moreMods = false
    }
    //posts.push(p)
  }

  /*
  // loop pulling specific number of posts
  for (let i = 1; i <= count; i++) {
    await handlePostRefresh(i)
  }
  */

  // loop to pull a post while there are more updates
  for (let i = 1; moreMods; i++) {
    await handlePostRefresh(i)
  }

  /*
  // write to file
  const fileName = `newModPosts-${new Date().getTime()}.json`
  fs.writeFileSync(fileName, JSON.stringify(posts), 'utf8')
  console.log(`${fileName} written`)
  */
}

const main = async () => {
  try {
    await refresh()
  } catch (e) {
    if (e.name === 'FetchError')
      console.log(`failed connecting to ${dbCtrlUrl} (will retry later)`)
    console.log(e)
  }
  setInterval(async () => {
    console.log('refreshing...')
    try {
      await refresh()
    } catch (e) {
      if (e.name === 'FetchError')
        console.log(`failed connecting to ${dbCtrlUrl} (will retry later)`)
      else console.log(e)
    }
    console.log(`next refresh in ${refreshTimer}ms`)
  }, refreshTimer)
}

main()
