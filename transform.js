const dotenv = require('dotenv')
const fs = require('fs')
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
const dbCtrlUrl = process.env.DB_CTRL_URL

const modifyPost = async (wp, p, cats, wpTags) => {
  // helper functions
  const markupToMarkdown = str => {
    return turndown.turndown(str)
  }
  const getLex = md => {
    return marked.lexer(md)
  }
  let result = {
    id: p.id,
    isSticky: p.sticky,
    slug: p.slug,
    status: p.status,
    categories: [],
    title: markupToMarkdown(p.title.rendered),
    date: new Date(p.date).getTime(),
    modified: new Date(p.modified).getTime(),
    authors: p.acf.imt_author,
    excerpt: markupToMarkdown(p.excerpt.rendered),
    media: '',
    content: '',
    tags: [],
  }

  // categories
  p.categories.forEach(catId => {
    cats.forEach(cat => {
      if (catId === cat.id) {
        // push this category
        result.categories.push(cat)
        if (result.categories.find(d => d.id === cat.parent) === undefined) {
          // parent hasn't already been added
          // find and push parent
          result.categories.push(cats.find(d => d.id === cat.parent))
        }
      }
    })
  })

  // content
  const markdown = markupToMarkdown(p.content.rendered)
  //console.log(markdown)
  const lex = getLex(markdown)
  //console.log(lex)
  const reg = /\!\[(.*?)\]\(.*?\)/g
  let newLex = []
  lex.forEach(d => {
    let imgs = d.text.match(reg) // array of imgs in this entry
    let texts = [] // array of texts in this entry
    d.text.split(reg).forEach(t => {
      if (t.length !== '') texts.push(t)
    })
    if (imgs !== null) {
      if (imgs.length > 1) console.log('multiple imgs in a single paragraph')
      if (imgs.length > 0) {
        // grab img link from markdown
        const linkReg = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/
        // insert img entry
        newLex.push({
          key: 'img',
          val: imgs[0].match(linkReg)[0],
        })
      }
    }
    texts.forEach((t, i) => {
      if (t.length > 0) {
        //console.log(lex.links)
        let content = t.trim()
        const refReg = /\[\d{1,2}\]/g // match 1 or 2 length ref links
        let refLinks = content.match(refReg)
        //console.log(refLinks)
        if (refLinks !== null) {
          content += `\n`
          refLinks.forEach(refLink => {
            let ref = refLink.replace('[', '')
            ref = ref.replace(']', '')
            content += `\n${refLink}: ${lex.links[ref].href}`
          })
        }
        newLex.push({
          key: d.type === 'paragraph' ? 'p' : d.type,
          val: content,
        })
      }
    })
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
      console.debug(`${id} not found, retrieving from wordpress`)
      let wpTag = await wp.tags().id(id)
      wpTags.push(wpTag)
      result.tags.push(wpTag.name)
    }
  })
  await Promise.all(promises)

  return result
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
  // remove Uncategorized
  return newCats.filter(p => p.name !== 'Uncategorized')
}

const main = async () => {
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
  console.log('getting tags...')
  let wpTags = await getAll(wp.tags())
  console.log(`${wpTags.length} tags retrieved`)

  // handle posts
  let count = 1 // number of posts to mod
  let posts = []

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
    // this cms modification is more recent than db

    //console.log(`modifying post for webapp`)
    p = await modifyPost(wp, p, cats, wpTags)

    /*
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
    */
    posts.push(p)
  }
  for (let i = 1; i <= count; i++) {
    await handlePostRefresh(i)
  }

  const fileName = `newModPosts-${new Date().getTime()}.json`
  fs.writeFileSync(fileName, JSON.stringify(posts), 'utf8')
  console.log(`${fileName} written`)
}

main()
