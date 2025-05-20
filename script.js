// Constants
const GAME_ID = '2217000';
const CORS_PROXY = 'https://corsproxy.io/?';
const STORAGE_KEYS = {
    ELO_DATA: 'roa2_elo_data',
    LAST_UPDATED: 'roa2_last_updated',
    SELECTED_LEADERBOARD: 'roa2_selected_leaderboard',
    LAST_SEARCHED_ID: 'roa2_last_searched_id'
};
const DATA_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Rank thresholds based on official ELO ranges
const RANK_THRESHOLDS = {
    'Stone': 0,
    'Bronze': 500,
    'Silver': 700,
    'Gold': 900,
    'Platinum': 1100,
    'Diamond': 1300,
    'Master': 1500,
    'Grandmaster': 1700,
    'Aetherean': 1800
};

// Rank colors and patterns
const RANK_STYLES = {
    'Stone': { color: '#808080', pattern: 'repeating-linear-gradient(45deg, #808080, #808080 10px, #666666 10px, #666666 20px)' },
    'Bronze': { color: '#CD7F32', pattern: 'repeating-linear-gradient(45deg, #CD7F32, #CD7F32 10px, #B87333 10px, #B87333 20px)' },
    'Silver': { color: '#C0C0C0', pattern: 'repeating-linear-gradient(45deg, #C0C0C0, #C0C0C0 10px, #A9A9A9 10px, #A9A9A9 20px)' },
    'Gold': { color: '#FFD700', pattern: 'repeating-linear-gradient(45deg, #FFD700, #FFD700 10px, #DAA520 10px, #DAA520 20px)' },
    'Platinum': { color: '#E5E4E2', pattern: 'repeating-linear-gradient(45deg, #E5E4E2, #E5E4E2 10px, #C0C0C0 10px, #C0C0C0 20px)' },
    'Diamond': { color: '#B9F2FF', pattern: 'repeating-linear-gradient(45deg, #B9F2FF, #B9F2FF 10px, #00FFFF 10px, #00FFFF 20px)' },
    'Master': { color: '#50C878', pattern: 'repeating-linear-gradient(45deg, #50C878, #50C878 10px, #3CB371 10px, #3CB371 20px)' },
    'Grandmaster': { color: '#FF4500', pattern: 'repeating-linear-gradient(45deg, #FF4500, #FF4500 10px, #FF6347 10px, #FF6347 20px)' },
    'Aetherean': { color: '#9370DB', pattern: 'repeating-linear-gradient(45deg, #9370DB, #9370DB 10px, #8A2BE2 10px, #8A2BE2 20px)' }
};

// Cache for rank colors
let rankColors = {};

// Function to get dominant color from a base64 image
async function getDominantColor(base64Image) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let r = 0, g = 0, b = 0, count = 0;

            for (let i = 0; i < imageData.length; i += 4) {
                // Skip transparent pixels
                if (imageData[i + 3] < 128) continue;

                r += imageData[i];
                g += imageData[i + 1];
                b += imageData[i + 2];
                count++;
            }

            if (count > 0) {
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);
            }

            resolve(`rgb(${r}, ${g}, ${b})`);
        };
        img.onerror = reject;
        img.src = base64Image;
    });
}

// Function to create pattern from base64 image
async function createPattern(base64Image) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            resolve(ctx.createPattern(canvas, 'repeat'));
        };
        img.onerror = reject;
        img.src = base64Image;
    });
}

// Initialize rank colors
async function initializeRankColors() {
    for (const [rank, base64Image] of Object.entries(RANK_IMAGES)) {
        try {
            rankColors[rank] = await getDominantColor(base64Image);
        } catch (error) {
            console.error(`Failed to get color for ${rank}:`, error);
            // Fallback color
            rankColors[rank] = '#6C63FF';
        }
    }
}

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchButton = document.getElementById('searchButton');
const refreshButton = document.getElementById('refreshButton');
const playerStats = document.getElementById('playerStats');
const playerAvatar = document.getElementById('playerAvatar');
const playerName = document.getElementById('playerName');
const playerElo = document.getElementById('playerElo');
const playerRank = document.getElementById('playerRank');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const leaderboardSelect = document.getElementById('leaderboardSelect');
let eloChart = null;

// Initialize the application
async function init() {
    console.log('Initializing application...');
    showLoading();

    try {
        await populateLeaderboardDropdown();
        await loadData();
        console.log('Data loaded, updating chart...');
        updateEloDistribution();
        updateRefreshButtonTooltip();

        // Load last searched player if exists
        const lastSearchedId = sessionStorage.getItem(STORAGE_KEYS.LAST_SEARCHED_ID);
        if (lastSearchedId) {
            searchInput.value = lastSearchedId;
            await displayPlayerStats(lastSearchedId);
        }
    } catch (error) {
        console.error('Error during initialization:', error);
        alert('Failed to initialize the application. Please try again.');
    } finally {
        hideLoading();
    }
}

// Show/hide loading overlay
function showLoading(message = 'Loading data...') {
    loadingText.textContent = message;
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    loadingOverlay.style.display = 'flex';
}

function updateProgress(current, total) {
    const percentage = Math.round((current / total) * 100);
    progressBar.style.width = `${percentage}%`;
    progressText.textContent = `${percentage}%`;
}

function hideLoading() {
    loadingOverlay.style.display = 'none';
}

// Populate leaderboard dropdown
async function populateLeaderboardDropdown() {
    console.log('Fetching leaderboard data...');
    const leaderboardUrl = `https://steamcommunity.com/stats/${GAME_ID}/leaderboards/?xml=1`;

    const leaderboardResponse = await fetch(CORS_PROXY + encodeURIComponent(leaderboardUrl), {
        headers: {
            'Origin': window.location.origin
        }
    });

    if (!leaderboardResponse.ok) {
        throw new Error(`Leaderboard fetch failed: ${leaderboardResponse.status} ${leaderboardResponse.statusText}`);
    }

    const leaderboardData = await leaderboardResponse.text();
    const parser = new DOMParser();
    const leaderboardDoc = parser.parseFromString(leaderboardData, 'text/xml');

    // Check for XML parsing errors
    const parseError = leaderboardDoc.querySelector('parsererror');
    if (parseError) {
        throw new Error('Failed to parse leaderboard XML: ' + parseError.textContent);
    }

    // Get all leaderboards
    const leaderboards = leaderboardDoc.querySelectorAll('leaderboard');
    if (!leaderboards.length) {
        console.error('No leaderboards found. XML content:', leaderboardData);
        throw new Error('No leaderboards found in response');
    }

    console.log('Found leaderboards:', leaderboards.length);

    // Populate leaderboard select dropdown
    leaderboardSelect.innerHTML = '';
    leaderboards.forEach(lb => {
        const name = lb.querySelector('name')?.textContent || lb.querySelector('displayName')?.textContent;
        const id = lb.querySelector('lbid')?.textContent;

        if (name && id) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = name;
            leaderboardSelect.appendChild(option);
        } else {
            console.warn('Invalid leaderboard entry:', { name, id });
        }
    });

    // Get the selected leaderboard ID (default to latest leaderboard)
    let selectedLeaderboardId = sessionStorage.getItem(STORAGE_KEYS.SELECTED_LEADERBOARD);
    if (!selectedLeaderboardId) {
        // Use the last leaderboard in the list (most recent)
        selectedLeaderboardId = leaderboards[leaderboards.length - 1].querySelector('lbid')?.textContent;
    }

    // Ensure the selected ID exists in the dropdown
    const selectedOption = Array.from(leaderboardSelect.options).find(opt => opt.value === selectedLeaderboardId);
    if (!selectedOption) {
        console.warn('Selected leaderboard ID not found in options, using first available');
        selectedLeaderboardId = leaderboards[0].querySelector('lbid')?.textContent;
    }

    leaderboardSelect.value = selectedLeaderboardId;
    console.log('Selected leaderboard ID:', selectedLeaderboardId);
}

// Data management
async function loadData() {
    const lastUpdated = parseInt(sessionStorage.getItem(STORAGE_KEYS.LAST_UPDATED) || '0');
    const now = Date.now();

    // Check if data has expired
    if (now - lastUpdated > DATA_EXPIRY_MS) {
        console.log('Data has expired, fetching fresh data...');
        sessionStorage.removeItem(STORAGE_KEYS.ELO_DATA);
        await fetchAndStoreData();
    } else {
        console.log('Using cached data from session storage');
    }

    updateRefreshButtonTooltip();
}

function updateRefreshButtonTooltip() {
    const lastUpdated = parseInt(sessionStorage.getItem(STORAGE_KEYS.LAST_UPDATED) || '0');
    const now = Date.now();
    const timeLeft = DATA_EXPIRY_MS - (now - lastUpdated);

    if (timeLeft <= 0) {
        refreshButton.title = 'Data has expired. Click to refresh.';
        return;
    }

    const hours = Math.floor(timeLeft / (60 * 60 * 1000));
    const minutes = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));
    refreshButton.title = `Data will refresh in ${hours}h ${minutes}m`;
}

async function fetchAndStoreData() {
    try {
        console.log('Starting data fetch...');
        showLoading('Fetching leaderboard data...');

        // Get the selected leaderboard ID
        const selectedLeaderboardId = leaderboardSelect.value;
        if (!selectedLeaderboardId) {
            throw new Error('No leaderboard selected');
        }

        // Get total number of entries for selected leaderboard
        const leaderboardUrl = `https://steamcommunity.com/stats/${GAME_ID}/leaderboards/?xml=1`;
        const leaderboardResponse = await fetch(CORS_PROXY + encodeURIComponent(leaderboardUrl), {
            headers: {
                'Origin': window.location.origin
            }
        });

        if (!leaderboardResponse.ok) {
            throw new Error(`Leaderboard fetch failed: ${leaderboardResponse.status} ${leaderboardResponse.statusText}`);
        }

        const leaderboardData = await leaderboardResponse.text();
        const parser = new DOMParser();
        const leaderboardDoc = parser.parseFromString(leaderboardData, 'text/xml');

        const selectedLeaderboard = Array.from(leaderboardDoc.querySelectorAll('leaderboard')).find(lb =>
            lb.querySelector('lbid')?.textContent === selectedLeaderboardId
        );
        if (!selectedLeaderboard) {
            throw new Error('Selected leaderboard not found');
        }

        const totalEntries = parseInt(selectedLeaderboard.querySelector('entries')?.textContent || '0');
        console.log('Total entries in leaderboard:', totalEntries);

        // Fetch leaderboard entries with pagination
        console.log('Fetching leaderboard entries...');
        showLoading('Fetching leaderboard entries...');
        const eloData = {};
        const BATCH_SIZE = 5001; // Maximum entries per request
        let processedEntries = 0;

        for (let start = 1; start <= totalEntries; start += BATCH_SIZE) {
            const end = Math.min(start + BATCH_SIZE - 1, totalEntries);
            console.log(`Fetching entries ${start} to ${end}...`);

            const entriesUrl = `https://steamcommunity.com/stats/${GAME_ID}/leaderboards/${selectedLeaderboardId}/?xml=1&start=${start}&end=${end}`;
            console.log('Entries URL:', entriesUrl);

            const entriesResponse = await fetch(CORS_PROXY + encodeURIComponent(entriesUrl), {
                headers: {
                    'Origin': window.location.origin
                }
            });

            if (!entriesResponse.ok) {
                throw new Error(`Entries fetch failed: ${entriesResponse.status} ${entriesResponse.statusText}`);
            }

            const entriesData = await entriesResponse.text();
            const entriesDoc = parser.parseFromString(entriesData, 'text/xml');

            // Check for XML parsing errors
            const entriesParseError = entriesDoc.querySelector('parsererror');
            if (entriesParseError) {
                throw new Error('Failed to parse entries XML: ' + entriesParseError.textContent);
            }

            // Process entries
            const entries = entriesDoc.querySelectorAll('entry');
            console.log(`Found ${entries.length} entries in batch ${start}-${end}`);

            entries.forEach(entry => {
                const steamId = entry.querySelector('steamid')?.textContent;
                const score = parseInt(entry.querySelector('score')?.textContent);

                if (!steamId || isNaN(score)) {
                    console.warn('Invalid entry found:', entry);
                    return;
                }

                eloData[steamId] = score;
                processedEntries++;
            });

            updateProgress(processedEntries, totalEntries);

            // Add a small delay between requests to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('Processed ELO data:', Object.keys(eloData).length, 'entries');

        if (Object.keys(eloData).length === 0) {
            throw new Error('No valid ELO data found');
        }

        // Store data with current timestamp
        sessionStorage.setItem(STORAGE_KEYS.ELO_DATA, JSON.stringify(eloData));
        sessionStorage.setItem(STORAGE_KEYS.LAST_UPDATED, Date.now().toString());
        sessionStorage.setItem(STORAGE_KEYS.SELECTED_LEADERBOARD, selectedLeaderboardId);
        console.log('All data stored in session storage');

        // Update the refresh button tooltip
        updateRefreshButtonTooltip();

    } catch (error) {
        console.error('Error fetching data:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack
        });
        throw error;
    }
}

// UI Updates
async function updateEloDistribution() {
    console.log('Updating ELO distribution...');
    const eloData = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.ELO_DATA) || '{}');
    console.log('ELO data from storage:', Object.keys(eloData).length, 'entries');

    const distribution = calculateEloDistribution(eloData);
    console.log('Calculated distribution:', distribution);

    const ctx = document.getElementById('eloDistribution').getContext('2d');

    if (eloChart) {
        eloChart.destroy();
    }

    eloChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(distribution),
            datasets: [{
                label: 'Number of Players',
                data: Object.values(distribution),
                backgroundColor: Object.keys(distribution).map(rank => RANK_STYLES[rank].pattern),
                borderColor: Object.keys(distribution).map(rank => RANK_STYLES[rank].color),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    display: false
                },
                title: {
                    display: true,
                    text: 'ELO Distribution by Rank',
                    color: '#FFFFFF',
                    font: {
                        family: 'Poppins',
                        size: 16,
                        weight: '500'
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#B0B0B0',
                        font: {
                            family: 'Poppins'
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                x: {
                    ticks: {
                        color: '#B0B0B0',
                        font: {
                            family: 'Poppins'
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
    console.log('Chart updated');
}

function calculateEloDistribution(eloData) {
    const distribution = {};
    Object.keys(RANK_THRESHOLDS).forEach(rank => {
        distribution[rank] = 0;
    });

    Object.values(eloData).forEach(elo => {
        // Find the highest rank the player qualifies for
        let highestRank = 'Stone';
        for (const [rank, threshold] of Object.entries(RANK_THRESHOLDS)) {
            if (elo >= threshold) {
                highestRank = rank;
            }
        }
        distribution[highestRank]++;
    });

    return distribution;
}

async function getSteamUserInfo(steamId) {
    try {
        const url = `https://steamcommunity.com/profiles/${steamId}/?xml=1`;
        const response = await fetch(CORS_PROXY + encodeURIComponent(url), {
            headers: {
                'Origin': window.location.origin
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Steam user info: ${response.status}`);
        }

        const data = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(data, 'text/xml');

        const profile = doc.querySelector('profile');
        if (!profile) {
            throw new Error('Invalid profile data');
        }

        return {
            name: profile.querySelector('steamID')?.textContent || 'Unknown',
            avatar: profile.querySelector('avatarFull')?.textContent || 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'
        };
    } catch (error) {
        console.error('Error fetching Steam user info:', error);
        return {
            name: `Steam ID: ${steamId}`,
            avatar: 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'
        };
    }
}

async function displayPlayerStats(steamId) {
    const eloData = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.ELO_DATA) || '{}');
    const elo = eloData[steamId];

    if (!elo) {
        alert('Player not found');
        return;
    }

    // Determine rank
    let rank = 'Stone';
    for (const [r, threshold] of Object.entries(RANK_THRESHOLDS)) {
        if (elo >= threshold) {
            rank = r;
        }
    }

    // Show loading state
    playerName.textContent = 'Loading...';
    playerAvatar.src = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
    playerStats.style.display = 'block';

    // Fetch Steam user info
    const userInfo = await getSteamUserInfo(steamId);

    // Update UI with user info
    playerName.textContent = userInfo.name;
    playerElo.textContent = elo;
    playerRank.textContent = rank;
    playerAvatar.src = userInfo.avatar;
    playerAvatar.onerror = function () {
        this.src = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/fe/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';
    };
}

async function getSteamIdFromCustomUrl(customUrl) {
    try {
        const url = `https://steamcommunity.com/id/${customUrl}/?xml=1`;
        const response = await fetch(CORS_PROXY + encodeURIComponent(url), {
            headers: {
                'Origin': window.location.origin
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch Steam profile: ${response.status}`);
        }

        const data = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(data, 'text/xml');

        const profile = doc.querySelector('profile');
        if (!profile) {
            throw new Error('Invalid profile data');
        }

        const steamId = profile.querySelector('steamID64')?.textContent;
        if (!steamId) {
            throw new Error('Could not find Steam ID');
        }

        return steamId;
    } catch (error) {
        console.error('Error fetching Steam ID from custom URL:', error);
        throw error;
    }
}

async function searchPlayer(searchTerm) {
    searchTerm = searchTerm.trim();
    if (!searchTerm) return;

    let steamId;

    // Check if it's a Steam ID (64 digits)
    if (/^\d{17}$/.test(searchTerm)) {
        steamId = searchTerm;
    } else {
        // Try as custom URL
        try {
            steamId = await getSteamIdFromCustomUrl(searchTerm);
        } catch (error) {
            alert('Invalid Steam ID or custom URL. Please enter a valid 17-digit Steam ID or Steam custom URL.');
            return;
        }
    }

    // Store the searched ID
    sessionStorage.setItem(STORAGE_KEYS.LAST_SEARCHED_ID, steamId);

    // Display player stats
    await displayPlayerStats(steamId);
}

// Event Listeners
searchButton.addEventListener('click', () => {
    searchPlayer(searchInput.value);
});

// Add enter key support for search
searchInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
        searchPlayer(searchInput.value);
    }
});

refreshButton.addEventListener('click', async () => {
    showLoading();
    try {
        await fetchAndStoreData();
        await updateEloDistribution();
    } catch (error) {
        console.error('Error refreshing data:', error);
        alert('Failed to refresh data. Please try again.');
    } finally {
        hideLoading();
    }
});

// Add event listener for leaderboard selection
leaderboardSelect.addEventListener('change', async () => {
    const selectedId = leaderboardSelect.value;
    sessionStorage.setItem(STORAGE_KEYS.SELECTED_LEADERBOARD, selectedId);
    showLoading();
    try {
        await fetchAndStoreData();
        await updateEloDistribution();

        // Refresh player stats if a player was previously searched
        const lastSearchedId = sessionStorage.getItem(STORAGE_KEYS.LAST_SEARCHED_ID);
        if (lastSearchedId && playerStats.style.display !== 'none') {
            await displayPlayerStats(lastSearchedId);
        }
    } catch (error) {
        console.error('Error changing leaderboard:', error);
        alert('Failed to change leaderboard. Please try again.');
    } finally {
        hideLoading();
    }
});

// Add periodic tooltip updates
setInterval(updateRefreshButtonTooltip, 60000); // Update every minute

// Initialize the app
init(); 