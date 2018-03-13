const DOMParser = require('xmldom').DOMParser

module.exports = cats => {
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
