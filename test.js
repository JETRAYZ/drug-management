const str = `
    \${test.map(d => \`
    hello
    \`).join('')}
`;
console.log(str);
